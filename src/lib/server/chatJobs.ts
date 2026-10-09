import type { Firestore, Transaction } from "firebase-admin/firestore";
import { getAdminDb } from "./firebaseAdmin";
import { HttpError, type AuthedUser } from "./auth";
import { logJob } from "./jobLog";
import type { ChatLink } from "@/lib/chat/links";
import {
  MAX_MESSAGE_CHARS,
  REQUEST_ID_RE,
  conversationIdFor,
  isTerminalStatus,
  jobIdFor,
  orderId,
  type ChatMessageDoc,
  type ChatMessageKind,
  type JobActionView,
  type JobFailureView,
  type JobStatus,
  type JobView,
} from "@/lib/chat/types";

/**
 * Durable job store for the AI chat. Firestore is the queue AND the state: a job is accepted in one transaction,
 * claimed with a lease, checkpointed step by step, and finished/failed in one transaction each. Nothing here
 * depends on any single server process staying alive.
 *
 * Collections (all written only by this module through the Admin SDK; clients may only read their own messages):
 *   chatConversations/{cid}                 counters + owner (cid = storeId__uid)
 *   chatConversations/{cid}/messages/{n}    chat transcript + mirrored job state on user messages
 *   chatConversations/{cid}/requests/{id}   idempotency records (client requestId → job)
 *   chatJobs/{jobId}                        lease, status, progress
 *   chatJobs/{jobId}/steps/{n}              the model's response for step n (checkpoint BEFORE tools run)
 *   chatJobs/{jobId}/toolCalls/{toolUseId}  each tool's result (checkpoint AFTER it ran)
 */

/** A worker owns a job for this long unless it heartbeats; a crashed worker's job becomes claimable after it. */
export const LEASE_MS = 60_000;
export const HEARTBEAT_MS = 20_000;
/** Times a job may be claimed (first run + takeovers after crashes/deferrals) before it is failed for manual retry. */
export const MAX_CLAIMS = 4;
/** Deliberate time-budget hand-offs allowed for one job before it stops and asks for a manual retry (loop guard). */
export const MAX_DEFERRALS = 10;
/** Follow-ups queued behind unfinished work in one conversation. */
export const MAX_QUEUED_JOBS = 10;
const MAX_ACTIONS_MIRRORED = 40;

/** Injectable time source so tests can move the clock past a lease. */
export const timeSource = { now: () => Date.now() };

export class LeaseLostError extends Error {
  constructor(jobId: string) {
    super(`Lease on job ${jobId} was lost`);
  }
}

export interface ConversationDoc {
  storeId: string;
  ownerUid: string;
  ownerEmail: string;
  /** Last allocated job sequence number. */
  jobCounter: number;
  /** Sequence number of the last job that reached a terminal state, in order. Job n may run only when n === headSeq + 1. */
  headSeq: number;
  createdAt: number;
  updatedAt: number;
}

export interface JobDoc {
  conversationId: string;
  ownerUid: string;
  storeId: string;
  seq: number;
  requestId: string;
  status: JobStatus;
  attempts: number;
  /** Times this job was handed to a fresh invocation because the current one ran out of time. Absent on older docs. */
  deferrals?: number;
  leaseOwner: string | null;
  leaseExpiresAt: number;
  /** True when this job is the user's reply to a question the AI asked — the only case force=true is honoured. */
  canConfirm: boolean;
  answersJobId: string | null;
  answeredBy: string | null;
  actions: JobActionView[];
  failure: JobFailureView | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface StepDoc {
  contentJson: string;
  createdAt: number;
}

export interface ToolCallDoc {
  step: number;
  name: string;
  inputJson: string;
  mutating: boolean;
  operationId: string | null;
  resultJson: string;
  resultStatus: string | null;
  completedAt: number;
}

/* --------------------------------- helpers -------------------------------- */

const db = (): Firestore => getAdminDb();
const convRef = (cid: string) => db().collection("chatConversations").doc(cid);
const jobRef = (jobId: string) => db().collection("chatJobs").doc(jobId);
const messageRef = (cid: string, order: number) => convRef(cid).collection("messages").doc(orderId(order));
const userOrder = (seq: number) => seq * 2;
const replyOrder = (seq: number) => seq * 2 + 1;

function viewOf(jobId: string, job: JobDoc): JobView {
  return {
    id: jobId,
    seq: job.seq,
    status: job.status,
    attempts: job.attempts,
    updatedAt: job.updatedAt,
    actions: job.actions,
    ...(job.failure ? { failure: job.failure } : {}),
  };
}

/** Writes the job doc and mirrors its state onto the user's message — always together, in the caller's transaction. */
function writeJob(tx: Transaction, jobId: string, job: JobDoc, changes: Partial<JobDoc>): JobDoc {
  const next: JobDoc = { ...job, ...changes, updatedAt: timeSource.now() };
  tx.set(jobRef(jobId), next);
  tx.update(messageRef(job.conversationId, userOrder(job.seq)), { job: viewOf(jobId, next) });
  return next;
}

async function readJobInTx(tx: Transaction, jobId: string): Promise<JobDoc | null> {
  const snap = await tx.get(jobRef(jobId));
  return snap.exists ? (snap.data() as JobDoc) : null;
}

function assertLease(job: JobDoc | null, jobId: string, workerId: string): asserts job is JobDoc {
  if (!job || job.status !== "running" || job.leaseOwner !== workerId) throw new LeaseLostError(jobId);
}

/* --------------------------------- accept --------------------------------- */

export interface AcceptResult {
  jobId: string;
  seq: number;
  status: JobStatus;
  /** True when this requestId was already accepted — the original job is returned and nothing new is written. */
  duplicate: boolean;
}

/**
 * Durably accepts a chat message. One transaction creates the user message, the job and the idempotency record, so
 * either everything exists (and a job ID can be returned) or nothing does. Retrying the same requestId is a no-op.
 */
export async function acceptMessage(user: AuthedUser, input: { requestId: string; content: string }): Promise<AcceptResult> {
  const content = (input.content ?? "").trim();
  if (!REQUEST_ID_RE.test(input.requestId ?? "")) throw new HttpError(400, "requestId không hợp lệ.");
  if (!content) throw new HttpError(400, "Tin nhắn trống.");
  if (content.length > MAX_MESSAGE_CHARS) throw new HttpError(400, `Tin nhắn quá dài (tối đa ${MAX_MESSAGE_CHARS} ký tự).`);

  const cid = conversationIdFor(user.storeId, user.uid);
  const cRef = convRef(cid);
  const reqRef = cRef.collection("requests").doc(input.requestId);

  const acceptStart = performance.now();
  const accepted = await db().runTransaction(async (tx): Promise<AcceptResult> => {
    // ---- reads ----
    const reqSnap = await tx.get(reqRef);
    if (reqSnap.exists) {
      const { jobId, seq } = reqSnap.data() as { jobId: string; seq: number };
      const existing = await readJobInTx(tx, jobId);
      return { jobId, seq, status: existing?.status ?? "accepted", duplicate: true };
    }
    const convSnap = await tx.get(cRef);
    const now = timeSource.now();
    const conv: ConversationDoc = convSnap.exists
      ? (convSnap.data() as ConversationDoc)
      : {
          storeId: user.storeId,
          ownerUid: user.uid,
          ownerEmail: user.email,
          jobCounter: 0,
          headSeq: 0,
          createdAt: now,
          updatedAt: now,
        };
    if (conv.ownerUid !== user.uid) throw new HttpError(403, "Không có quyền truy cập cuộc trò chuyện này.");
    if (conv.jobCounter - conv.headSeq >= MAX_QUEUED_JOBS) {
      throw new HttpError(429, "Đang có quá nhiều yêu cầu chờ xử lý — đợi một chút rồi gửi tiếp nhé.");
    }

    const seq = conv.jobCounter + 1;
    const jobId = jobIdFor(cid, seq);
    const priorId = seq > 1 ? jobIdFor(cid, seq - 1) : null;
    const prior = priorId ? await readJobInTx(tx, priorId) : null;
    const answersWaiting = prior?.status === "waiting_for_input";

    // ---- writes ----
    const job: JobDoc = {
      conversationId: cid,
      ownerUid: user.uid,
      storeId: user.storeId,
      seq,
      requestId: input.requestId,
      status: "accepted",
      attempts: 0,
      leaseOwner: null,
      leaseExpiresAt: 0,
      canConfirm: answersWaiting,
      answersJobId: answersWaiting ? priorId : null,
      answeredBy: null,
      actions: [],
      failure: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
    };
    const message: ChatMessageDoc = {
      ownerUid: user.uid,
      order: userOrder(seq),
      role: "user",
      content,
      jobId,
      jobSeq: seq,
      createdAt: now,
      requestId: input.requestId,
      job: viewOf(jobId, job),
    };
    tx.set(cRef, { ...conv, jobCounter: seq, updatedAt: now });
    tx.create(jobRef(jobId), job);
    tx.create(messageRef(cid, userOrder(seq)), message);
    tx.create(reqRef, { jobId, seq, createdAt: now });
    if (answersWaiting && priorId) tx.update(jobRef(priorId), { answeredBy: jobId });
    return { jobId, seq, status: "accepted", duplicate: false };
  });
  logJob("accepted", accepted.jobId, { seq: accepted.seq, duplicate: accepted.duplicate, commitMs: performance.now() - acceptStart });
  return accepted;
}

/* ---------------------------- claim / lease / queue ---------------------------- */

export type ClaimResult =
  | { ok: true; job: JobDoc; firstClaim: boolean; sinceCreatedMs: number; sinceLastActivityMs: number }
  | { ok: false; reason: "missing" | "terminal" | "queued" | "leased" | "exhausted" };

/**
 * Takes the lease on a job if — and only if — it is runnable: not finished, next in its conversation's order,
 * and not currently held by a live worker. A job whose worker died (expired lease) is taken over here.
 */
export async function claimJob(jobId: string, workerId: string): Promise<ClaimResult> {
  return db().runTransaction(async (tx): Promise<ClaimResult> => {
    const job = await readJobInTx(tx, jobId);
    if (!job) return { ok: false, reason: "missing" };
    if (isTerminalStatus(job.status)) return { ok: false, reason: "terminal" };
    const convSnap = await tx.get(convRef(job.conversationId));
    const conv = convSnap.data() as ConversationDoc;
    if (job.seq !== conv.headSeq + 1) return { ok: false, reason: "queued" };
    const now = timeSource.now();
    if (job.status === "running" && job.leaseExpiresAt > now) return { ok: false, reason: "leased" };
    if (job.attempts >= MAX_CLAIMS || (job.deferrals ?? 0) >= MAX_DEFERRALS) return { ok: false, reason: "exhausted" };

    const next = writeJob(tx, jobId, job, {
      status: "running",
      attempts: job.attempts + 1,
      leaseOwner: workerId,
      leaseExpiresAt: now + LEASE_MS,
      startedAt: job.startedAt ?? now,
    });
    return {
      ok: true,
      job: next,
      firstClaim: job.startedAt === null,
      sinceCreatedMs: now - job.createdAt,
      sinceLastActivityMs: now - job.updatedAt,
    };
  });
}

/** Extends the lease. Throws LeaseLostError if another worker has taken over (this worker must then stop writing). */
export async function heartbeat(jobId: string, workerId: string): Promise<void> {
  await db().runTransaction(async (tx) => {
    const job = await readJobInTx(tx, jobId);
    assertLease(job, jobId, workerId);
    tx.update(jobRef(jobId), { leaseExpiresAt: timeSource.now() + LEASE_MS, updatedAt: timeSource.now() });
  });
}

/**
 * Hands the job back so a fresh invocation continues from the checkpoint.
 *  - "budget": this invocation ran out of time. A deliberate hand-off is not a failure, so it doesn't burn a claim
 *    attempt — but it is counted in `deferrals`, which is capped so a job can't hand itself off forever.
 *  - "error": a retryable error and not enough time left to retry here. This DOES count as an attempt, so a
 *    persistently failing job still ends up failed (retryable by hand) instead of looping.
 */
export async function releaseJob(jobId: string, workerId: string, reason: "budget" | "error" = "budget"): Promise<void> {
  await db().runTransaction(async (tx) => {
    const job = await readJobInTx(tx, jobId);
    assertLease(job, jobId, workerId);
    writeJob(tx, jobId, job, {
      status: "accepted",
      leaseOwner: null,
      leaseExpiresAt: 0,
      ...(reason === "budget" ? { attempts: Math.max(0, job.attempts - 1), deferrals: (job.deferrals ?? 0) + 1 } : {}),
    });
  });
}

/* ------------------------------- checkpoints ------------------------------- */

/**
 * Saves the model's response for step `n` (create-if-absent) and returns the CANONICAL content: if another worker
 * already saved a different response for this step, that one wins — so every worker executes the same tool calls.
 */
export async function saveStep(jobId: string, workerId: string, n: number, contentJson: string): Promise<string> {
  const stepRef = jobRef(jobId).collection("steps").doc(orderId(n));
  return db().runTransaction(async (tx) => {
    const job = await readJobInTx(tx, jobId);
    assertLease(job, jobId, workerId);
    const snap = await tx.get(stepRef);
    if (snap.exists) return (snap.data() as StepDoc).contentJson;
    tx.create(stepRef, { contentJson, createdAt: timeSource.now() } satisfies StepDoc);
    tx.update(jobRef(jobId), { leaseExpiresAt: timeSource.now() + LEASE_MS, updatedAt: timeSource.now() });
    return contentJson;
  });
}

/**
 * Saves tool results (one or many) and updates the visible progress in ONE transaction. Idempotent per toolUseId:
 * results already saved are left untouched. `calls` order is the tool_use order and is preserved in `actions`.
 */
export async function saveToolCalls(jobId: string, workerId: string, calls: { toolUseId: string; call: ToolCallDoc }[]): Promise<void> {
  if (calls.length === 0) return;
  const refs = calls.map(({ toolUseId }) => jobRef(jobId).collection("toolCalls").doc(toolUseId));
  await db().runTransaction(async (tx) => {
    const job = await readJobInTx(tx, jobId);
    assertLease(job, jobId, workerId);
    const existing = await Promise.all(refs.map((r) => tx.get(r)));
    const fresh = calls.filter((_, i) => !existing[i].exists);
    if (fresh.length === 0) return;
    fresh.forEach(({ toolUseId, call }) => tx.create(jobRef(jobId).collection("toolCalls").doc(toolUseId), call));
    const added: JobActionView[] = fresh.map(({ call }) => ({ tool: call.name, mutating: call.mutating, ...(call.resultStatus ? { status: call.resultStatus } : {}) }));
    writeJob(tx, jobId, job, {
      actions: [...job.actions, ...added].slice(-MAX_ACTIONS_MIRRORED),
      leaseExpiresAt: timeSource.now() + LEASE_MS,
    });
  });
}

/** Saves one tool result and updates the visible progress. Idempotent per toolUseId. */
export async function saveToolCall(jobId: string, workerId: string, toolUseId: string, call: ToolCallDoc): Promise<void> {
  await saveToolCalls(jobId, workerId, [{ toolUseId, call }]);
}

export async function loadCheckpoint(jobId: string): Promise<{ steps: Map<number, string>; toolCalls: Map<string, ToolCallDoc> }> {
  const [stepSnap, callSnap] = await Promise.all([
    jobRef(jobId).collection("steps").get(),
    jobRef(jobId).collection("toolCalls").get(),
  ]);
  const steps = new Map<number, string>();
  for (const d of stepSnap.docs) steps.set(Number(d.id), (d.data() as StepDoc).contentJson);
  const toolCalls = new Map<string, ToolCallDoc>();
  for (const d of callSnap.docs) toolCalls.set(d.id, d.data() as ToolCallDoc);
  return { steps, toolCalls };
}

/** The last `limit` transcript messages up to and including this job's user message, oldest first. */
export async function loadHistory(job: JobDoc, limit: number): Promise<{ role: "user" | "assistant"; content: string }[]> {
  const snap = await convRef(job.conversationId)
    .collection("messages")
    .where("order", "<=", userOrder(job.seq))
    .orderBy("order", "desc")
    .limit(limit)
    .get();
  const msgs = snap.docs.map((d) => d.data() as ChatMessageDoc).reverse();
  // The API requires the first turn to be the user's.
  while (msgs.length > 0 && msgs[0].role !== "user") msgs.shift();
  return msgs.map((m) => ({ role: m.role, content: m.content }));
}

/* -------------------------------- completion -------------------------------- */

export interface FinishInput {
  status: "completed" | "waiting_for_input";
  text: string;
  actions: { tool: string; result: { status?: string } }[];
  /** Shortcut buttons to the records this reply touched (see src/lib/chat/links.ts). */
  links?: ChatLink[];
}

/**
 * Finishes a job: reply message, final status and queue advance commit atomically, and only the current lease
 * owner may do it — so a job can never complete twice or be completed by a zombie worker.
 */
export async function finishJob(jobId: string, workerId: string, input: FinishInput): Promise<void> {
  await db().runTransaction(async (tx) => {
    const job = await readJobInTx(tx, jobId);
    assertLease(job, jobId, workerId);
    const now = timeSource.now();
    const kind: ChatMessageKind = input.status === "waiting_for_input" ? "question" : "text";
    const reply: ChatMessageDoc = {
      ownerUid: job.ownerUid,
      order: replyOrder(job.seq),
      role: "assistant",
      content: input.text,
      jobId,
      jobSeq: job.seq,
      createdAt: now,
      kind,
      actions: input.actions.slice(0, MAX_ACTIONS_MIRRORED),
      ...(input.links && input.links.length > 0 ? { links: input.links } : {}),
    };
    tx.set(messageRef(job.conversationId, replyOrder(job.seq)), reply);
    tx.update(convRef(job.conversationId), { headSeq: job.seq, updatedAt: now });
    writeJob(tx, jobId, job, { status: input.status, leaseOwner: null, leaseExpiresAt: 0, finishedAt: now, failure: null });
  });
}

/**
 * Marks a job failed and saves a plain-language explanation (including what DID get done, so nothing is repeated
 * or forgotten). Pass `workerId` when the caller holds the lease; pass null for a job nobody is running.
 */
export async function failJob(jobId: string, workerId: string | null, failure: JobFailureView, text: string): Promise<void> {
  await db().runTransaction(async (tx) => {
    const job = await readJobInTx(tx, jobId);
    if (!job || isTerminalStatus(job.status)) return;
    if (workerId) assertLease(job, jobId, workerId);
    else if (job.status === "running" && job.leaseExpiresAt > timeSource.now()) return; // someone is running it
    const now = timeSource.now();
    const reply: ChatMessageDoc = {
      ownerUid: job.ownerUid,
      order: replyOrder(job.seq),
      role: "assistant",
      content: text,
      jobId,
      jobSeq: job.seq,
      createdAt: now,
      kind: "error",
      actions: job.actions.slice(0, MAX_ACTIONS_MIRRORED).map((a) => ({ tool: a.tool, result: { status: a.status } })),
    };
    tx.set(messageRef(job.conversationId, replyOrder(job.seq)), reply);
    tx.update(convRef(job.conversationId), { headSeq: job.seq, updatedAt: now });
    writeJob(tx, jobId, job, { status: "failed", leaseOwner: null, leaseExpiresAt: 0, finishedAt: now, failure });
  });
}

/**
 * Manual "Thử lại" for a failed job. Allowed only for the newest job of the conversation (so it can't run out of
 * order against later messages). Keeps every checkpoint, so completed steps and tool calls are NOT repeated.
 */
export async function retryJob(user: AuthedUser, jobId: string): Promise<{ status: JobStatus }> {
  return db().runTransaction(async (tx) => {
    const job = await readJobInTx(tx, jobId);
    if (!job || job.ownerUid !== user.uid) throw new HttpError(404, "Không tìm thấy yêu cầu này.");
    const convSnap = await tx.get(convRef(job.conversationId));
    const conv = convSnap.data() as ConversationDoc;
    if (job.status !== "failed") return { status: job.status };
    if (job.seq !== conv.jobCounter || conv.headSeq !== job.seq) {
      throw new HttpError(409, "Đã có tin nhắn mới hơn — hãy gửi lại yêu cầu trong tin nhắn mới.");
    }
    tx.update(convRef(job.conversationId), { headSeq: job.seq - 1, updatedAt: timeSource.now() });
    // The failure note is a status message, not user data; the real reply replaces it when the job finishes.
    tx.delete(messageRef(job.conversationId, replyOrder(job.seq)));
    writeJob(tx, jobId, job, { status: "accepted", attempts: 0, deferrals: 0, leaseOwner: null, leaseExpiresAt: 0, failure: null, finishedAt: null });
    return { status: "accepted" as JobStatus };
  });
}

/* --------------------------------- queries --------------------------------- */

export async function getJobForUser(user: AuthedUser, jobId: string): Promise<JobDoc> {
  const snap = await jobRef(jobId).get();
  const job = snap.exists ? (snap.data() as JobDoc) : null;
  // Same response for "missing" and "not yours" so ids can't be probed.
  if (!job || job.ownerUid !== user.uid || job.storeId !== user.storeId) throw new HttpError(404, "Không tìm thấy yêu cầu này.");
  return job;
}

/** Current status of a job by id, for server-to-server callers that authenticate with a secret instead of a user. */
export async function peekJobStatus(jobId: string): Promise<JobStatus | null> {
  const snap = await jobRef(jobId).get();
  return snap.exists ? (snap.data() as JobDoc).status : null;
}

/** Id of the job queued right behind `job` in its conversation, if any. */
export async function nextJobId(job: JobDoc): Promise<string | null> {
  const nextId = jobIdFor(job.conversationId, job.seq + 1);
  const snap = await jobRef(nextId).get();
  return snap.exists ? nextId : null;
}

/** Unfinished jobs (for the recovery sweep). Each is then driven through claimJob, which decides if it is runnable. */
export async function listUnfinishedJobIds(limit: number): Promise<string[]> {
  const snap = await db().collection("chatJobs").where("status", "in", ["accepted", "running"]).limit(limit).get();
  return snap.docs.map((d) => d.id);
}
