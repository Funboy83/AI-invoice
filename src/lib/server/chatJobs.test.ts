import { beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { store, adminFacade } from "@/test/fakeFirestore";
import { __setAdminDbForTests } from "./firebaseAdmin";
import { HttpError, type AuthedUser } from "./auth";
import {
  LEASE_MS,
  MAX_CLAIMS,
  MAX_QUEUED_JOBS,
  LeaseLostError,
  acceptMessage,
  claimJob,
  failJob,
  finishJob,
  getJobForUser,
  loadCheckpoint,
  releaseJob,
  retryJob,
  saveStep,
  saveToolCall,
  timeSource,
  type JobDoc,
} from "./chatJobs";
import type { ChatMessageDoc } from "@/lib/chat/types";

const wife: AuthedUser = { uid: "wife", email: "wife@example.com", storeId: "main" };
const other: AuthedUser = { uid: "intruder", email: "intruder@example.com", storeId: "main" };
const CID = "main__wife";

let clock = 1_000_000;
const advance = (ms: number) => (clock += ms);

beforeEach(() => {
  store.reset();
  clock = 1_000_000;
  timeSource.now = () => clock;
  __setAdminDbForTests(adminFacade() as unknown as Firestore);
});

const job = (seq: number) => store.read(`chatJobs/${CID}__j${String(seq).padStart(6, "0")}`) as unknown as JobDoc;
const userMsg = (seq: number) => store.read(`chatConversations/${CID}/messages/${String(seq * 2).padStart(8, "0")}`) as unknown as ChatMessageDoc;
const replyMsg = (seq: number) => store.read(`chatConversations/${CID}/messages/${String(seq * 2 + 1).padStart(8, "0")}`) as unknown as ChatMessageDoc | undefined;
let reqCounter = 0;
const accept = (content: string, requestId = `req-${++reqCounter}-xxxxxxxx`, user = wife) => acceptMessage(user, { requestId, content });

describe("acceptMessage", () => {
  it("durably records message, job and idempotency key together and returns the job id", async () => {
    const r = await accept("tạo invoice cho Hoa 10 milo 29");
    expect(r).toMatchObject({ seq: 1, status: "accepted", duplicate: false });
    expect(job(1)).toMatchObject({ status: "accepted", ownerUid: "wife", attempts: 0, leaseOwner: null, canConfirm: false });
    expect(userMsg(1)).toMatchObject({ role: "user", content: "tạo invoice cho Hoa 10 milo 29", ownerUid: "wife", jobId: r.jobId });
    expect(userMsg(1).job).toMatchObject({ status: "accepted", id: r.jobId });
    expect(store.read(`chatConversations/${CID}`)).toMatchObject({ jobCounter: 1, headSeq: 0, ownerUid: "wife" });
  });

  it("is idempotent: retrying the same requestId returns the same job and writes nothing new", async () => {
    const a = await accept("hello", "same-request-1");
    const before = new Map(store.docs);
    const b = await accept("hello", "same-request-1");
    expect(b).toMatchObject({ jobId: a.jobId, seq: 1, duplicate: true });
    expect(store.docs.size).toBe(before.size);
    expect(store.count(`chatConversations/${CID}/messages`)).toBe(1);
    expect(store.count("chatJobs")).toBe(1);
  });

  it("concurrent identical requests produce exactly one job", async () => {
    const results = await Promise.all([accept("x", "dup-request-1"), accept("x", "dup-request-1"), accept("x", "dup-request-1")]);
    expect(new Set(results.map((r) => r.jobId)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(store.count("chatJobs")).toBe(1);
  });

  it("rejects invalid input with a 400 and stores nothing", async () => {
    for (const bad of [
      { requestId: "short", content: "hi" },
      { requestId: "valid-request-id", content: "   " },
      { requestId: "valid-request-id", content: "x".repeat(8001) },
      { requestId: "bad id with spaces!", content: "hi" },
    ]) {
      await expect(acceptMessage(wife, bad)).rejects.toMatchObject({ status: 400 });
    }
    expect(store.docs.size).toBe(0);
  });

  it("caps how many follow-ups can pile up behind unfinished work", async () => {
    for (let i = 0; i < MAX_QUEUED_JOBS; i++) await accept(`m${i}`);
    await expect(accept("one too many")).rejects.toMatchObject({ status: 429 });
  });

  it("gives each account its own conversation — nothing is shared or visible across users", async () => {
    await accept("wife's private order", "wife-request-1");
    const theirs = await accept("intruder message", "intruder-req-1", other);
    expect(theirs.jobId).toContain("main__intruder");
    expect(store.count("chatConversations/main__intruder/messages")).toBe(1);
    expect(store.count(`chatConversations/${CID}/messages`)).toBe(1);
    // the intruder cannot look up the wife's job, and the failure looks the same as "does not exist"
    await expect(getJobForUser(other, `${CID}__j000001`)).rejects.toMatchObject({ status: 404 });
    await expect(getJobForUser(other, "nonexistent")).rejects.toMatchObject({ status: 404 });
    await expect(getJobForUser(wife, `${CID}__j000001`)).resolves.toMatchObject({ ownerUid: "wife" });
  });

  it("two different approved accounts both work independently — a job's identity comes ONLY from the authenticated caller, never anything in the request body", async () => {
    // acceptMessage's own type signature only accepts {requestId, content} — this proves it at the runtime boundary
    // too: even if a caller (or a route that forgot to sanitize) passed extra fields shaped like storeId/ownerUid,
    // they have no effect. The route itself (src/app/api/chat/route.ts) only ever forwards requestId/content.
    const forgedInput = { requestId: "forged-req-1", content: "hi", storeId: "some-other-store", ownerUid: "not-wife", uid: "not-wife" };
    const a = await acceptMessage(wife, forgedInput as unknown as { requestId: string; content: string });
    expect(job(1)).toMatchObject({ ownerUid: "wife", storeId: "main" });

    const b = await acceptMessage(other, { requestId: "other-req-1", content: "hi" });
    expect(store.read(`chatJobs/${b.jobId}`)).toMatchObject({ ownerUid: other.uid, storeId: other.storeId });

    // both proceed to completion independently, in their own conversations, neither blocking or leaking into the other
    const w1 = "w1";
    await claimJob(a.jobId, w1);
    await finishJob(a.jobId, w1, { status: "completed", text: "done for wife", actions: [] });
    const w2 = "w2";
    await claimJob(b.jobId, w2);
    await finishJob(b.jobId, w2, { status: "completed", text: "done for other", actions: [] });
    expect(store.count(`chatConversations/${CID}/messages`)).toBe(2);
    expect(store.count(`chatConversations/main__${other.uid}/messages`)).toBe(2);
  });

  it("marks a reply to a waiting question as confirmable — and only that", async () => {
    const q = await accept("first");
    const w1 = "w1";
    await claimJob(q.jobId, w1);
    await finishJob(q.jobId, w1, { status: "waiting_for_input", text: "Ý bạn là Milo cũ hay mới?", actions: [] });

    const answer = await accept("mới", "answer-request-1");
    expect(job(2)).toMatchObject({ canConfirm: true, answersJobId: q.jobId });
    expect(job(1).answeredBy).toBe(answer.jobId);

    // a later unrelated message is not a confirmation
    const w2 = "w2";
    await claimJob(answer.jobId, w2);
    await finishJob(answer.jobId, w2, { status: "completed", text: "ok", actions: [] });
    await accept("another", "another-req-1");
    expect(job(3).canConfirm).toBe(false);
  });
});

describe("claiming, leases and ordering", () => {
  it("only one worker can hold a job at a time", async () => {
    const { jobId } = await accept("a");
    const first = await claimJob(jobId, "w1");
    expect(first).toMatchObject({ ok: true });
    expect(await claimJob(jobId, "w2")).toEqual({ ok: false, reason: "leased" });
    expect(job(1)).toMatchObject({ status: "running", leaseOwner: "w1", attempts: 1 });
    expect(userMsg(1).job).toMatchObject({ status: "running" });
  });

  it("racing claims produce exactly one winner", async () => {
    const { jobId } = await accept("a");
    const results = await Promise.all(["w1", "w2", "w3", "w4"].map((w) => claimJob(jobId, w)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("a follow-up is accepted immediately but cannot run until the earlier job reaches a terminal state", async () => {
    const a = await accept("first");
    const b = await accept("follow-up");
    expect(b.status).toBe("accepted");
    expect(await claimJob(b.jobId, "w2")).toEqual({ ok: false, reason: "queued" });

    await claimJob(a.jobId, "w1");
    expect(await claimJob(b.jobId, "w2")).toEqual({ ok: false, reason: "queued" }); // still running
    await finishJob(a.jobId, "w1", { status: "completed", text: "done", actions: [] });
    expect(await claimJob(b.jobId, "w2")).toMatchObject({ ok: true });
  });

  it("a failed earlier job also releases the queue (its note explains what happened)", async () => {
    const a = await accept("first");
    const b = await accept("second");
    await claimJob(a.jobId, "w1");
    await failJob(a.jobId, "w1", { message: "boom", retryable: true }, "⚠️ failed");
    expect(await claimJob(b.jobId, "w2")).toMatchObject({ ok: true });
  });

  it("takes over a job whose worker died once the lease expires, and counts the attempt", async () => {
    const { jobId } = await accept("a");
    await claimJob(jobId, "dead-worker");
    advance(LEASE_MS - 1);
    expect(await claimJob(jobId, "w2")).toEqual({ ok: false, reason: "leased" });
    advance(2);
    const t = await claimJob(jobId, "w2");
    expect(t).toMatchObject({ ok: true });
    expect(job(1)).toMatchObject({ leaseOwner: "w2", attempts: 2 });
  });

  it("fences a zombie worker: after takeover its checkpoint and completion writes are rejected", async () => {
    const { jobId } = await accept("a");
    await claimJob(jobId, "zombie");
    advance(LEASE_MS + 1);
    await claimJob(jobId, "fresh");

    await expect(saveStep(jobId, "zombie", 1, "[]")).rejects.toBeInstanceOf(LeaseLostError);
    await expect(
      saveToolCall(jobId, "zombie", "t1", { step: 1, name: "x", inputJson: "{}", mutating: false, operationId: null, resultJson: "{}", resultStatus: null, completedAt: 1 })
    ).rejects.toBeInstanceOf(LeaseLostError);
    await expect(finishJob(jobId, "zombie", { status: "completed", text: "late", actions: [] })).rejects.toBeInstanceOf(LeaseLostError);

    expect(replyMsg(1)).toBeUndefined();
    expect(job(1).status).toBe("running");
    expect((await loadCheckpoint(jobId)).steps.size).toBe(0);
  });

  it("a job can complete only once", async () => {
    const { jobId } = await accept("a");
    await claimJob(jobId, "w1");
    await finishJob(jobId, "w1", { status: "completed", text: "done", actions: [] });
    await expect(finishJob(jobId, "w1", { status: "completed", text: "again", actions: [] })).rejects.toBeInstanceOf(LeaseLostError);
    expect(replyMsg(1)?.content).toBe("done");
  });

  it("first writer wins for a step: a racing worker adopts the saved model output instead of its own", async () => {
    const { jobId } = await accept("a");
    await claimJob(jobId, "w1");
    expect(await saveStep(jobId, "w1", 1, '["first"]')).toBe('["first"]');
    expect(await saveStep(jobId, "w1", 1, '["second"]')).toBe('["first"]');
  });

  it("stops handing a job out after MAX_CLAIMS interrupted runs", async () => {
    const { jobId } = await accept("a");
    for (let i = 0; i < MAX_CLAIMS; i++) {
      expect(await claimJob(jobId, `w${i}`)).toMatchObject({ ok: true });
      advance(LEASE_MS + 1);
    }
    expect(await claimJob(jobId, "wN")).toEqual({ ok: false, reason: "exhausted" });
  });

  it("releasing a job (time budget) hands it back without burning an attempt", async () => {
    const { jobId } = await accept("a");
    await claimJob(jobId, "w1");
    await releaseJob(jobId, "w1");
    expect(job(1)).toMatchObject({ status: "accepted", leaseOwner: null, attempts: 0 });
    expect(await claimJob(jobId, "w2")).toMatchObject({ ok: true });
  });
});

describe("failure and retry", () => {
  it("failJob saves an explanation as the reply and mirrors the failure to the message", async () => {
    const { jobId } = await accept("a");
    await claimJob(jobId, "w1");
    await failJob(jobId, "w1", { message: "network", retryable: true }, "⚠️ Đã tạo invoice #2000; chưa ghi thanh toán");
    expect(job(1)).toMatchObject({ status: "failed", leaseOwner: null });
    expect(replyMsg(1)).toMatchObject({ kind: "error", content: expect.stringContaining("#2000") });
    expect(userMsg(1).job).toMatchObject({ status: "failed", failure: { retryable: true } });
    expect(store.read(`chatConversations/${CID}`)).toMatchObject({ headSeq: 1 });
  });

  it("failJob on a job nobody holds does not steal a live worker's job, and is a no-op once terminal", async () => {
    const { jobId } = await accept("a");
    await claimJob(jobId, "live");
    await failJob(jobId, null, { message: "x", retryable: true }, "nope"); // lease still valid
    expect(job(1).status).toBe("running");
    advance(LEASE_MS + 1);
    await failJob(jobId, null, { message: "x", retryable: true }, "gave up");
    expect(job(1).status).toBe("failed");
    await failJob(jobId, null, { message: "y", retryable: true }, "again");
    expect(replyMsg(1)?.content).toBe("gave up");
  });

  it("retry re-queues the newest failed job, removes the failure note and KEEPS its checkpoints", async () => {
    const { jobId } = await accept("a");
    await claimJob(jobId, "w1");
    await saveStep(jobId, "w1", 1, '[{"type":"text","text":"x"}]');
    await failJob(jobId, "w1", { message: "network", retryable: true }, "⚠️ failed");

    expect(await retryJob(wife, jobId)).toEqual({ status: "accepted" });
    expect(job(1)).toMatchObject({ status: "accepted", attempts: 0, failure: null });
    expect(replyMsg(1)).toBeUndefined();
    expect(store.read(`chatConversations/${CID}`)).toMatchObject({ headSeq: 0 });
    expect((await loadCheckpoint(jobId)).steps.size).toBe(1);
    expect(await claimJob(jobId, "w2")).toMatchObject({ ok: true });
  });

  it("retry is refused once a newer message exists (it would run out of order) and for other users' jobs", async () => {
    const a = await accept("a");
    await claimJob(a.jobId, "w1");
    await failJob(a.jobId, "w1", { message: "x", retryable: true }, "⚠️");
    await accept("newer message");
    await expect(retryJob(wife, a.jobId)).rejects.toMatchObject({ status: 409 });
    await expect(retryJob(other, a.jobId)).rejects.toBeInstanceOf(HttpError);
    expect(job(1).status).toBe("failed");
  });

  it("retrying a job that isn't failed changes nothing", async () => {
    const { jobId } = await accept("a");
    expect(await retryJob(wife, jobId)).toEqual({ status: "accepted" });
    await claimJob(jobId, "w1");
    expect(await retryJob(wife, jobId)).toEqual({ status: "running" });
    expect(job(1)).toMatchObject({ status: "running", leaseOwner: "w1" });
  });
});
