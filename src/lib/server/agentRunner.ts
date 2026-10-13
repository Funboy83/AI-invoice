import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { toolDefinitions, executeTool, MUTATING_TOOLS, operationIdFor, type ToolContext } from "@/lib/ai/tools";
import { SYSTEM_PROMPT, storePrompt } from "@/lib/ai/systemPrompt";
import { runInStore } from "./storeContext";
import { choicesFromCandidates, cleanChoices, collectLinks, linksForToolResult, type ChatLink } from "@/lib/chat/links";
import { ConfigError, getAdminDb } from "./firebaseAdmin";
import { isMember } from "./membership";
import { dispatchContinuation } from "./dispatch";
import { deliverReplyToTelegram } from "./telegram";
import { logJob, timed } from "./jobLog";
import {
  HEARTBEAT_MS,
  LeaseLostError,
  claimJob,
  failJob,
  finishJob,
  heartbeat,
  loadCheckpoint,
  loadHistory,
  nextJobId,
  releaseJob,
  saveStep,
  saveToolCalls,
  timeSource,
  type FinishInput,
  type JobDoc,
  type ToolCallDoc,
} from "./chatJobs";

const HISTORY_LIMIT = 40; // cap resent history so cost doesn't grow with conversation length
const MAX_STEPS = 10; // cap on model↔tool round trips per job
const MAX_RESULT_CHARS = 120_000; // keeps a single tool result well under Firestore's 1 MiB doc limit
const MAX_IN_PROCESS_RETRIES = 2; // for non-model failures (Firestore, tools); model calls have their own bounded retry

/**
 * Time model. One invocation may run for at most INVOCATION_LIMIT_MS — this MUST equal `maxDuration` (seconds) on
 * the routes that start work (a test enforces it). Everything that can take long is sized from what is LEFT of that:
 *  - a model call gets min(MODEL_TIMEOUT_MS, remaining − FINALIZE_RESERVE_MS) and is not started at all if that is
 *    under MIN_MODEL_CALL_MS;
 *  - retries/backoff only happen if another attempt would still fit;
 *  - otherwise the job is handed to a fresh invocation from its checkpoint (never abandoned mid-call by the platform).
 * FINALIZE_RESERVE_MS keeps room after the last model call for checkpoints, the final reply and the hand-off itself.
 */
export const INVOCATION_LIMIT_MS = 300_000;
export const FINALIZE_RESERVE_MS = 25_000;
export const MODEL_TIMEOUT_MS = 60_000;
export const MIN_MODEL_CALL_MS = 15_000;
const MAX_MODEL_ATTEMPTS = 3;
/** Don't start another queued job in this invocation unless at least this much time remains. */
const MIN_TIME_TO_CHAIN_MS = 60_000;
/** Independent read-only tool calls of one model turn run at most this many at a time. */
export const READ_CONCURRENCY = 4;

const BLOCKING_STATUSES = new Set(["needs_confirmation", "needs_new_product", "needs_new_customer", "needs_more_info"]);
/** Tools that neither change data nor wait on the user; calls to them within one model turn are independent. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(
  toolDefinitions.map((t) => t.name).filter((n) => !MUTATING_TOOLS.has(n) && n !== "requestUserInput")
);

export interface RunnerDeps {
  createMessage(
    params: Anthropic.Messages.MessageCreateParamsNonStreaming,
    opts: { timeoutMs: number }
  ): Promise<Anthropic.Messages.Message>;
  executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
  sleep(ms: number): Promise<void>;
  /** Total time this invocation may run (defaults to INVOCATION_LIMIT_MS). */
  budgetMs: number;
  /** Starts a fresh invocation for a job that must continue elsewhere; resolves to whether it was accepted. */
  continueJob(jobId: string): Promise<boolean>;
  /** Called once a job has its final reply saved (finished, waiting for an answer, or failed) — e.g. to send it to Telegram. */
  onJobDone?(job: JobDoc): Promise<void>;
}

export function defaultDeps(): RunnerDeps {
  return {
    async createMessage(params, { timeoutMs }) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new ConfigError("ANTHROPIC_API_KEY is not configured on the server.");
      // Timeout comes from the remaining invocation budget; retries are ours (budget-aware), not the SDK's.
      return new Anthropic({ apiKey }).messages.create(params, { timeout: timeoutMs, maxRetries: 0 });
    },
    executeTool,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    budgetMs: INVOCATION_LIMIT_MS,
    continueJob: dispatchContinuation,
    onJobDone: deliverReplyToTelegram,
  };
}

/* --------------------------------- helpers -------------------------------- */

type ToolUse = Anthropic.Messages.ToolUseBlock;
type ContentBlock = Anthropic.Messages.ContentBlock;

const toolUsesOf = (content: ContentBlock[]) => content.filter((b): b is ToolUse => b.type === "tool_use");
const textOf = (content: ContentBlock[]) =>
  content
    .filter((b): b is Anthropic.Messages.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

function safeParse(json: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** True when a tool result means "the user has to decide/answer something before this can go on". */
function isBlocking(call: ToolCallDoc): boolean {
  if (call.resultStatus && BLOCKING_STATUSES.has(call.resultStatus)) return true;
  const incomplete = safeParse(call.resultJson)?.incompleteItems;
  return Array.isArray(incomplete) && incomplete.length > 0;
}

/** Tap-to-answer buttons from the latest tool result that listed similar customers/products (needs_confirmation). */
function candidateChoices(calls: ToolCallDoc[]): string[] {
  let choices: string[] = [];
  for (const call of calls) {
    const found = choicesFromCandidates(safeParse(call.resultJson));
    if (found.length > 0) choices = found;
  }
  return choices;
}

function capResult(json: string): string {
  if (json.length <= MAX_RESULT_CHARS) return json;
  return JSON.stringify({
    status: "truncated",
    message: "The result was too large to keep. Narrow the query (filter by customer, status or text) and try again.",
    preview: json.slice(0, 2000),
  });
}

/** Human-readable list of what a job already changed — used in failure notes so nothing is repeated or forgotten. */
function describeDone(calls: Iterable<ToolCallDoc>): string[] {
  const done: string[] = [];
  const ordered = [...calls].filter((c) => c.mutating).sort((a, b) => a.step - b.step || a.completedAt - b.completedAt);
  for (const c of ordered) {
    const r = safeParse(c.resultJson) ?? {};
    const ok = ["created", "updated", "finalized", "recorded", "alias_added"].includes(String(r.status));
    if (!ok) continue;
    const inv = r.invoice as { invoiceNumber?: string } | undefined;
    const num = inv?.invoiceNumber ? ` #${inv.invoiceNumber}` : "";
    if (c.name === "createInvoiceDraft" || c.name === "copyInvoice") done.push(`tạo invoice${num}`);
    else if (c.name === "recordPayment") done.push(`ghi nhận thanh toán $${(r.payment as { amount?: number } | undefined)?.amount ?? ""} cho invoice${num}`);
    else if (c.name === "createProduct") done.push(`thêm sản phẩm ${(r.product as { name?: string } | undefined)?.name ?? ""}`.trim());
    else if (c.name === "createCustomer") done.push(`thêm khách hàng ${(r.customer as { name?: string } | undefined)?.name ?? ""}`.trim());
    else if (inv) done.push(`sửa invoice${num} (${c.name})`);
    else done.push(c.name);
  }
  return done;
}

/** A model call that failed for good (non-retryable, or retries exhausted). Wraps the cause so callers can classify it. */
class ModelCallError extends Error {
  constructor(public cause: unknown) {
    super("model call failed");
  }
}

/** Not enough of this invocation is left to do the next thing safely; the job must continue elsewhere. */
class OutOfTime extends Error {
  constructor(public reason: "budget" | "error") {
    super(`out of time (${reason})`);
  }
}

function classify(input: unknown): { retryable: boolean; reason: string } {
  const err = input instanceof ModelCallError ? input.cause : input;
  if (err instanceof ConfigError) return { retryable: false, reason: err.message };
  if (err instanceof Anthropic.APIError) {
    const st = err.status;
    if (st === 401 || st === 403) return { retryable: false, reason: "khoá API của AI không hợp lệ hoặc hết quyền" };
    if (st === 400 || st === 404 || st === 413 || st === 422) return { retryable: false, reason: "AI từ chối yêu cầu này" };
  }
  return { retryable: true, reason: "gặp sự cố tạm thời (kết nối hoặc máy chủ)" };
}

/** Short machine code for logs. NEVER a message: messages can contain order text or customer data. */
function reasonCode(input: unknown): string {
  const err = input instanceof ModelCallError ? input.cause : input;
  if (err instanceof ConfigError) return "config";
  if (err instanceof LeaseLostError) return "lease_lost";
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (err instanceof Anthropic.APIConnectionError) return "connection";
  if (err instanceof Anthropic.APIError) return `anthropic_${err.status ?? "unknown"}`;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" || typeof code === "number") return `error_${code}`;
  return "error";
}

const ACCESS_REVOKED_MESSAGE = "⚠️ Tài khoản không còn quyền truy cập cửa hàng — yêu cầu này đã dừng lại.";

/**
 * Fails the job for revoked access — the ONE non-retryable, "stop right here" outcome that is not routed through
 * the generic classify()/retry machinery below. Used both before a job starts (runJob, right after claimJob) and
 * before every subsequent wave of tool calls within an attempt (executeAttempt), so a revocation that happens
 * mid-attempt cannot let a later step in the SAME attempt make a further mutation.
 */
async function denyForRevokedAccess(rc: RunCtx): Promise<void> {
  logJob("job_denied", rc.jobId, { reason: "revoked" });
  await failJob(rc.jobId, rc.workerId, { message: "Quyền truy cập đã bị thu hồi.", retryable: false }, ACCESS_REVOKED_MESSAGE);
}

function failureText(reason: string, retryable: boolean, done: string[]): string {
  const lines = [`⚠️ Mình chưa xử lý xong yêu cầu này: ${reason}.`];
  lines.push(done.length ? `✓ Đã làm xong: ${done.join("; ")}.` : "Chưa xác nhận được thay đổi nào đã được lưu.");
  if (retryable) lines.push('Bấm "Thử lại" để tiếp tục — những việc đã xong sẽ không bị làm lại.');
  return lines.join("\n\n");
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep the input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/* --------------------------------- running -------------------------------- */

interface Stats {
  modelMs: number;
  modelCalls: number;
  modelRetries: number;
  workerRetries: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolMs: number; // wall time spent executing tools (concurrent reads count once)
  toolCalls: number;
  checkpointMs: number;
  checkpoints: number;
  lastModelMs: number;
  lastModelOutputTokens: number;
  lastToolDoneAt: number | null;
}

interface RunCtx {
  jobId: string;
  workerId: string;
  job: JobDoc;
  deps: RunnerDeps;
  state: { lost: boolean };
  stats: Stats;
  /** Time left in this invocation. */
  remaining(): number;
}

type Attempt = "finished" | "deferred";
type RunOutcome = { kind: "finished"; job: JobDoc } | { kind: "deferred" } | { kind: "stopped" };

export interface DriveContext {
  /** When this invocation's clock started (route entry). Defaults to now. */
  invocationStart?: number;
}

/**
 * Drives a job (and then any jobs queued behind it in the same conversation) until nothing is runnable or the
 * invocation's time budget is spent. Safe to call any number of times, concurrently, from anywhere: claimJob
 * decides who runs, and every write is fenced by the lease. When a job has to continue elsewhere, this starts a
 * fresh invocation for it (deps.continueJob) instead of leaving it for the browser or a scheduler to notice.
 */
export async function driveJob(jobId: string, deps: RunnerDeps = defaultDeps(), ctx: DriveContext = {}): Promise<void> {
  const invocationStart = ctx.invocationStart ?? timeSource.now();
  const remaining = () => deps.budgetMs - (timeSource.now() - invocationStart);
  let id: string | null = jobId;
  while (id) {
    if (id !== jobId && remaining() < MIN_TIME_TO_CHAIN_MS) {
      await handOff(id, deps, "chain_budget");
      break;
    }
    const outcome: RunOutcome = await runJob(id, deps, remaining);
    if (outcome.kind === "deferred") {
      await handOff(id, deps, "deferred");
      break;
    }
    if (outcome.kind !== "finished") break;
    if (deps.onJobDone) {
      // A delivery problem (e.g. Telegram down) never fails the job: the reply is already saved in the app.
      await deps.onJobDone(outcome.job).catch(() => logJob("reply_delivery", id as string, { ok: false }));
    }
    id = await nextJobId(outcome.job);
  }
}

async function handOff(jobId: string, deps: RunnerDeps, why: string): Promise<void> {
  try {
    const ok = await deps.continueJob(jobId);
    logJob("hand_off", jobId, { why, dispatched: ok });
  } catch {
    logJob("hand_off", jobId, { why, dispatched: false });
  }
}

const newStats = (): Stats => ({
  modelMs: 0,
  modelCalls: 0,
  modelRetries: 0,
  workerRetries: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  toolMs: 0,
  toolCalls: 0,
  checkpointMs: 0,
  checkpoints: 0,
  lastModelMs: 0,
  lastModelOutputTokens: 0,
  lastToolDoneAt: null,
});

async function runJob(jobId: string, deps: RunnerDeps, remaining: () => number): Promise<RunOutcome> {
  const workerId = randomUUID();
  const claim = await claimJob(jobId, workerId);
  if (!claim.ok) {
    if (claim.reason === "exhausted") {
      // Every claim ended without finishing (worker kept dying / kept running out of time). Stop and let a person retry.
      const { toolCalls } = await loadCheckpoint(jobId);
      await failJob(
        jobId,
        null,
        { message: "Việc xử lý bị gián đoạn nhiều lần.", retryable: true },
        failureText("việc xử lý bị gián đoạn nhiều lần", true, describeDone(toolCalls.values()))
      );
      logJob("job_failed", jobId, { reason: "exhausted", retryable: true });
    }
    return { kind: "stopped" };
  }

  const job = claim.job;
  logJob("job_claimed", jobId, {
    seq: job.seq,
    attempt: job.attempts,
    firstClaim: claim.firstClaim,
    // acceptance → a worker actually starting (includes time queued behind earlier messages in the conversation)
    queueMs: claim.firstClaim ? claim.sinceCreatedMs : null,
    // for a takeover/continuation: how long the job sat with no worker
    idleBeforeClaimMs: claim.firstClaim ? null : claim.sinceLastActivityMs,
    remainingMs: remaining(),
  });

  const state = { lost: false };
  const stats = newStats();
  const rc: RunCtx = { jobId, workerId, job, deps, state, stats, remaining };

  // Membership is re-checked on EVERY claim — first run, resume, retry, self-dispatch continuation, and cron
  // sweep all go through here — using ONLY the identity persisted on the job at accept time (job.ownerUid /
  // job.storeId), never anything supplied by this call's caller. If access was revoked since the job was
  // accepted, stop here: no tool runs, so no new mutation happens, and nothing already committed on an earlier
  // attempt is touched, undone, or repeated. (executeAttempt below re-checks this again before every subsequent
  // wave of tool calls within the SAME attempt, so a revocation mid-attempt is caught just as fast.)
  if (!(await isMember(getAdminDb(), job.ownerUid, job.storeId))) {
    await denyForRevokedAccess(rc);
    return { kind: "finished", job };
  }

  const beat = setInterval(() => {
    heartbeat(jobId, workerId).catch((err) => {
      if (err instanceof LeaseLostError) state.lost = true;
    });
  }, HEARTBEAT_MS);
  beat.unref?.();

  try {
    for (let retry = 0; ; retry++) {
      try {
        const result = await executeAttempt(rc);
        if (result === "deferred") return { kind: "deferred" };
        return { kind: "finished", job };
      } catch (err) {
        if (err instanceof LeaseLostError) return { kind: "stopped" }; // another worker owns it now; stop writing
        const info = classify(err);
        const code = reasonCode(err);
        // Model calls already retried inside callModel; only other failures (Firestore, tools) retry the attempt here.
        if (info.retryable && !(err instanceof ModelCallError) && retry < MAX_IN_PROCESS_RETRIES) {
          const backoff = 1500 * 2 ** retry;
          if (remaining() - FINALIZE_RESERVE_MS > backoff + MIN_MODEL_CALL_MS) {
            stats.workerRetries++;
            logJob("worker_retry", jobId, { retry: retry + 1, reason: code, backoffMs: backoff, action: "retry", remainingMs: remaining() });
            // Re-running re-reads the checkpoint, so it is exactly the crash-recovery path: nothing done is redone.
            await deps.sleep(backoff);
            continue;
          }
          // Not enough time left here for another attempt: continue in a fresh invocation rather than being cut off.
          logJob("worker_retry", jobId, { retry: retry + 1, reason: code, action: "defer", remainingMs: remaining() });
          await releaseJob(jobId, workerId, "error");
          return { kind: "deferred" };
        }
        const { toolCalls } = await loadCheckpoint(jobId);
        await failJob(
          jobId,
          workerId,
          { message: info.reason, retryable: info.retryable },
          failureText(info.reason, info.retryable, describeDone(toolCalls.values()))
        );
        logJob("job_failed", jobId, { reason: code, retryable: info.retryable, workerRetries: stats.workerRetries, modelRetries: stats.modelRetries });
        return { kind: "finished", job };
      }
    }
  } catch (err) {
    if (err instanceof LeaseLostError) return { kind: "stopped" };
    throw err;
  } finally {
    clearInterval(beat);
  }
}

/** Timed checkpoint write; every checkpoint is logged with its duration. */
async function checkpoint<T>(rc: RunCtx, kind: string, fn: () => Promise<T>, fields: Record<string, number | string> = {}): Promise<T> {
  return timed(fn, (ms, ok) => {
    rc.stats.checkpointMs += ms;
    rc.stats.checkpoints++;
    logJob("checkpoint", rc.jobId, { kind, ms, ok, ...fields });
  });
}

/** One model call, sized to the time left, with bounded retries that only happen if another attempt still fits. */
async function callModel(rc: RunCtx, params: Anthropic.Messages.MessageCreateParamsNonStreaming, step: number): Promise<Anthropic.Messages.Message> {
  const { jobId, stats, deps } = rc;
  for (let attempt = 1; ; attempt++) {
    const window = rc.remaining() - FINALIZE_RESERVE_MS;
    if (window < MIN_MODEL_CALL_MS) throw new OutOfTime("budget");
    const timeoutMs = Math.min(MODEL_TIMEOUT_MS, window);
    const start = performance.now();
    try {
      const res = await deps.createMessage(params, { timeoutMs });
      const ms = performance.now() - start;
      const u = res.usage as Partial<Anthropic.Messages.Usage> | undefined;
      stats.modelMs += ms;
      stats.modelCalls++;
      stats.lastModelMs = ms;
      stats.lastModelOutputTokens = u?.output_tokens ?? 0;
      stats.inputTokens += u?.input_tokens ?? 0;
      stats.outputTokens += u?.output_tokens ?? 0;
      stats.cacheReadTokens += u?.cache_read_input_tokens ?? 0;
      stats.cacheWriteTokens += u?.cache_creation_input_tokens ?? 0;
      logJob("model_call", jobId, {
        step,
        attempt,
        ok: true,
        ms,
        timeoutMs,
        inputTokens: u?.input_tokens,
        outputTokens: u?.output_tokens,
        cacheReadTokens: u?.cache_read_input_tokens,
        cacheWriteTokens: u?.cache_creation_input_tokens,
        stopReason: res.stop_reason,
        toolUses: res.content?.filter((b) => b.type === "tool_use").length,
      });
      return res;
    } catch (err) {
      const ms = performance.now() - start;
      stats.modelMs += ms;
      const info = classify(err);
      const code = reasonCode(err);
      logJob("model_call", jobId, { step, attempt, ok: false, ms, timeoutMs, reason: code });
      if (!info.retryable || attempt >= MAX_MODEL_ATTEMPTS) throw new ModelCallError(err);
      const backoff = Math.min(1000 * 2 ** (attempt - 1), 8_000);
      // Only retry if, after backing off, a full useful attempt would still fit in what is left.
      if (rc.remaining() - FINALIZE_RESERVE_MS - backoff < MIN_MODEL_CALL_MS) {
        logJob("model_retry", jobId, { step, attempt, reason: code, action: "defer", remainingMs: rc.remaining() });
        throw new OutOfTime("error");
      }
      stats.modelRetries++;
      logJob("model_retry", jobId, { step, attempt, reason: code, action: "retry", backoffMs: backoff, remainingMs: rc.remaining() });
      await deps.sleep(backoff);
    }
  }
}

async function finish(rc: RunCtx, input: FinishInput): Promise<void> {
  await checkpoint(rc, "finish", () => finishJob(rc.jobId, rc.workerId, input));
  const s = rc.stats;
  const now = timeSource.now();
  logJob("job_finished", rc.jobId, {
    status: input.status,
    seq: rc.job.seq,
    // whole job, from acceptance to now
    totalMs: now - rc.job.createdAt,
    // this invocation's breakdown
    modelMs: s.modelMs,
    modelCalls: s.modelCalls,
    toolMs: s.toolMs,
    toolCalls: s.toolCalls,
    checkpointMs: s.checkpointMs,
    checkpoints: s.checkpoints,
    // the model call that wrote the final reply, and how long after the last tool result the job was done
    finalReplyMs: s.lastModelMs,
    finalReplyTokens: s.lastModelOutputTokens,
    tailAfterLastToolMs: s.lastToolDoneAt === null ? null : performance.now() - s.lastToolDoneAt,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheReadTokens: s.cacheReadTokens,
    cacheWriteTokens: s.cacheWriteTokens,
    modelRetries: s.modelRetries,
    workerRetries: s.workerRetries,
    attempts: rc.job.attempts,
  });
}

async function executeAttempt(rc: RunCtx): Promise<Attempt> {
  const { jobId, workerId, job, deps, state, stats } = rc;
  const guard = () => {
    if (state.lost) throw new LeaseLostError(jobId);
  };

  // Independent reads: run together.
  const [history, { steps: savedSteps, toolCalls: savedCalls }] = await checkpoint(rc, "load", () =>
    Promise.all([loadHistory(job, HISTORY_LIMIT), loadCheckpoint(jobId)])
  );
  const messages: Anthropic.Messages.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));
  const actions: { tool: string; result: { status?: string } }[] = [];
  const linkGroups: ChatLink[][] = [];
  const links = () => collectLinks(linkGroups);
  let previousStepCalls: ToolCallDoc[] = [];

  // The system prompt and tool schemas are identical on every request, so mark them cacheable.
  const system: Anthropic.Messages.TextBlockParam[] = [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: storePrompt(job.storeId) },
  ];
  const cachedTools = toolDefinitions.map((t, i) =>
    i === toolDefinitions.length - 1 ? { ...t, cache_control: { type: "ephemeral" as const } } : t
  );

  /** Runs one tool call (no checkpoint). For a write, an unexpected error aborts the attempt — see below. */
  async function execute(use: ToolUse, step: number, waveSize: number): Promise<ToolCallDoc> {
    guard();
    const mutating = MUTATING_TOOLS.has(use.name);
    const operationId = mutating ? operationIdFor(jobId, use.id) : null;
    const start = performance.now();
    let result: unknown;
    if (use.name === "requestUserInput") {
      result = { status: "awaiting_user" };
    } else {
      const ctx: ToolContext = {
        operationId: operationId ?? undefined,
        canConfirm: job.canConfirm,
        channel: job.origin?.channel ?? "app",
        trace: (phase, ms, fields) => logJob("tool_phase", jobId, { step, tool: use.name, phase, ms, ...fields }),
      };
      try {
        // Tools act ONLY on the store this job was accepted for (saved on the job, never taken from the caller).
        result = await runInStore(job.storeId, () => deps.executeTool(use.name, (use.input ?? {}) as Record<string, unknown>, ctx));
      } catch (err) {
        // For a write, an unexpected error may mean "committed but we never heard back": do NOT tell the model it
        // failed (it would retry under a new id). Abort the attempt; the retry replays the same operation id.
        if (mutating) throw err;
        result = { status: "error", message: err instanceof Error ? err.message : "Tool execution failed" };
      }
    }
    const resultJson = capResult(JSON.stringify(result ?? null));
    const status = (safeParse(resultJson)?.status as string | undefined) ?? null;
    const ms = performance.now() - start;
    logJob("tool_exec", jobId, { step, tool: use.name, ms, mutating, status: typeof status === "string" ? status : null, wave: waveSize });
    return {
      step,
      name: use.name,
      inputJson: JSON.stringify(use.input ?? {}),
      mutating,
      operationId,
      resultJson,
      resultStatus: typeof status === "string" ? status : null,
      completedAt: timeSource.now(),
    };
  }

  for (let n = 1; n <= MAX_STEPS; n++) {
    let contentJson = savedSteps.get(n);
    if (contentJson === undefined) {
      guard();
      // Checked before EVERY fresh model call (not only once at claim time): a job can span many turns, each a
      // real multi-second LLM call, so this both stops a revoked user's job from making any further mutation and
      // avoids spending more of her — now former — access on model calls that would be thrown away.
      if (!(await isMember(getAdminDb(), job.ownerUid, job.storeId))) {
        await denyForRevokedAccess(rc);
        return "finished";
      }
      let response: Anthropic.Messages.Message;
      try {
        response = await callModel(rc, { model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5", max_tokens: 2048, system, tools: cachedTools, messages }, n);
      } catch (err) {
        if (err instanceof OutOfTime) {
          logJob("job_deferred", jobId, { reason: err.reason, step: n, remainingMs: rc.remaining() });
          await checkpoint(rc, "release", () => releaseJob(jobId, workerId, err.reason)); // continue from the checkpoint in a fresh invocation
          return "deferred";
        }
        throw err;
      }
      guard();
      // Checkpoint BEFORE running any tool: a restart re-executes these exact calls (same ids), never re-asks the model.
      contentJson = await checkpoint(rc, "step", () => saveStep(jobId, workerId, n, JSON.stringify(response.content)), { step: n });
    }
    const content = JSON.parse(contentJson) as ContentBlock[];
    messages.push({ role: "assistant", content });

    const uses = toolUsesOf(content);
    if (uses.length === 0) {
      // Final reply. If the last tools left a question open, this job is waiting for her, not done.
      const waiting = previousStepCalls.some(isBlocking);
      const choices = waiting ? candidateChoices(previousStepCalls) : [];
      await finish(rc, { status: waiting ? "waiting_for_input" : "completed", text: textOf(content), actions, links: links(), choices });
      return "finished";
    }

    // Re-check membership before running ANY of this step's tools — not just once at claim time. A single
    // invocation can span many model turns (each a real, multi-second LLM call); without this, a revocation
    // landing between two turns of the SAME attempt would still let the next turn's tools execute.
    guard();
    if (!(await isMember(getAdminDb(), job.ownerUid, job.storeId))) {
      await denyForRevokedAccess(rc);
      return "finished";
    }

    // Execute this turn's tool calls. Order rules: results are kept in tool_use order; a consecutive run of read-only
    // calls is independent (the model wrote them without seeing any of their results) and runs concurrently, bounded;
    // every write (and requestUserInput) runs alone, in order, as a barrier — so anything after a write sees it.
    const results: (ToolCallDoc | undefined)[] = uses.map((u) => savedCalls.get(u.id));
    let i = 0;
    while (i < uses.length) {
      if (READ_ONLY_TOOLS.has(uses[i].name)) {
        let j = i;
        const pending: number[] = [];
        while (j < uses.length && READ_ONLY_TOOLS.has(uses[j].name)) {
          if (!results[j]) pending.push(j);
          j++;
        }
        if (pending.length > 0) {
          const wallStart = performance.now();
          let sumMs = 0;
          const docs = await mapLimit(pending, READ_CONCURRENCY, async (idx) => {
            const t = performance.now();
            const doc = await execute(uses[idx], n, pending.length);
            sumMs += performance.now() - t;
            return doc;
          });
          const wallMs = performance.now() - wallStart;
          stats.toolMs += wallMs;
          stats.toolCalls += pending.length;
          logJob("tool_wave", jobId, { step: n, size: pending.length, concurrency: Math.min(READ_CONCURRENCY, pending.length), wallMs, sumOfCallsMs: sumMs });
          guard();
          // One checkpoint for the whole wave, written in tool_use order.
          await checkpoint(rc, "tools", () => saveToolCalls(jobId, workerId, pending.map((idx, k) => ({ toolUseId: uses[idx].id, call: docs[k] }))), { count: pending.length });
          pending.forEach((idx, k) => (results[idx] = docs[k]));
          stats.lastToolDoneAt = performance.now();
        }
        i = j;
      } else {
        if (!results[i]) {
          const t = performance.now();
          const doc = await execute(uses[i], n, 1);
          stats.toolMs += performance.now() - t;
          stats.toolCalls++;
          guard();
          await checkpoint(rc, "tools", () => saveToolCalls(jobId, workerId, [{ toolUseId: uses[i].id, call: doc }]), { count: 1 });
          results[i] = doc;
          stats.lastToolDoneAt = performance.now();
        }
        i++;
      }
    }

    const stepCalls = results as ToolCallDoc[];
    let question: string | null = null;
    let choices: string[] = [];
    stepCalls.forEach((call, idx) => {
      actions.push({ tool: call.name, result: call.resultStatus ? { status: call.resultStatus } : {} });
      linkGroups.push(linksForToolResult(call.name, safeParse(call.inputJson), safeParse(call.resultJson)));
      if (uses[idx].name === "requestUserInput") {
        const input = uses[idx].input as { question?: unknown; options?: unknown };
        question = String(input?.question ?? "").trim();
        choices = cleanChoices(input?.options);
      }
    });
    // The AI asked without giving buttons: offer the similar records the previous step's tool found, if any.
    if (question !== null && choices.length === 0) choices = candidateChoices([...previousStepCalls, ...stepCalls]);

    if (question !== null) {
      const preface = textOf(content);
      const q: string = question;
      const text = preface && q && !preface.includes(q) ? `${preface}\n\n${q}` : preface || q;
      await finish(rc, { status: "waiting_for_input", text: text || "Mình cần bạn xác nhận thêm để tiếp tục.", actions, links: links(), choices });
      return "finished";
    }

    messages.push({
      role: "user",
      content: stepCalls.map((c, idx) => ({ type: "tool_result" as const, tool_use_id: uses[idx].id, content: c.resultJson })),
    });
    previousStepCalls = stepCalls;
  }

  // Step cap reached without a final answer: pause and ask her rather than looping (same fallback text as before).
  await finish(rc, {
    status: "waiting_for_input",
    text: "Mình đã thực hiện vài bước nhưng cần bạn xác nhận thêm trước khi tiếp tục — bạn nói rõ hơn giúp mình nhé?",
    actions,
    links: links(),
  });
  return "finished";
}
