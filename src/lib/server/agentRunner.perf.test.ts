import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("firebase/firestore", async () => (await import("@/test/fakeFirestore")).clientModule);
vi.mock("@/lib/firebase", () => ({ db: {}, firebaseApp: {} }));

import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { store } from "@/test/fakeFirestore";
import { logJob, logSink } from "./jobLog";
import { MAX_DEFERRALS, retryJob } from "./chatJobs";
import { FINALIZE_RESERVE_MS, INVOCATION_LIMIT_MS, MIN_MODEL_CALL_MS, READ_CONCURRENCY, driveJob, defaultDeps } from "./agentRunner";
import { dispatchContinuation, workerBaseUrl } from "./dispatch";
import { POST as continueRoute } from "@/app/api/chat/jobs/[jobId]/continue/route";
import {
  advance,
  resetRunnerEnv,
  text,
  toolUse,
  toolResultsInOrder,
  scriptedModel,
  deps,
  deferred,
  waitFor,
  seedCatalog,
  seedMembership,
  wife,
  jobDoc,
  replyMsg,
  say,
  createDraft,
  realExecuteTool,
} from "@/test/runnerKit";
import type { RunnerDeps } from "./agentRunner";

type LogLine = Record<string, unknown>;
let lines: LogLine[] = [];
const events = (name: string) => lines.filter((l) => l.event === name);

beforeEach(() => {
  resetRunnerEnv();
  seedCatalog();
  lines = [];
  logSink.write = (l) => lines.push(JSON.parse(l));
});
afterEach(() => {
  logSink.write = (l) => console.info(l);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("timing logs", () => {
  it("record queue delay, each model call, tool, checkpoint, invoice commit and the final reply — with tokens and no customer data", async () => {
    const order = "tạo invoice cho Hoa Lee: 10 thùng Milo giá 29 — SECRET-ORDER-98765";
    const { jobId: id } = await say(order);
    advance(2_500); // the job waits 2.5s before a worker starts
    const model = scriptedModel([[createDraft()], [text("Đã tạo invoice cho Hoa Lee — SECRET-REPLY-555")]]);

    await driveJob(id, deps(model));

    // acceptance → worker start
    expect(events("job_claimed")[0]).toMatchObject({ jobId: id, firstClaim: true, queueMs: 2_500, attempt: 1 });
    // each model call, with token usage
    const calls = events("model_call");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ step: 1, attempt: 1, ok: true, inputTokens: 1200, outputTokens: 60, cacheReadTokens: 4000, stopReason: "tool_use", toolUses: 1 });
    expect(calls[1]).toMatchObject({ step: 2, stopReason: "end_turn", toolUses: 0 });
    expect(typeof calls[0].ms).toBe("number");
    // tool execution and its DB phases (invoice commit)
    expect(events("tool_exec")[0]).toMatchObject({ tool: "createInvoiceDraft", mutating: true, status: "created" });
    const phases = events("tool_phase").map((l) => l.phase);
    expect(phases).toEqual(["draft_reads", "invoice_commit"]);
    expect(events("tool_phase")[0]).toMatchObject({ catalogDocs: 3, historyDocs: 0, items: 1 });
    // checkpoints: load, step, tools, step, finish
    expect(events("checkpoint").map((l) => l.kind)).toEqual(["load", "step", "tools", "step", "finish"]);
    // the whole-job summary
    expect(events("job_finished")[0]).toMatchObject({
      status: "completed",
      modelCalls: 2,
      toolCalls: 1,
      checkpoints: 5,
      inputTokens: 2_400,
      outputTokens: 120,
      cacheReadTokens: 8_000,
      totalMs: 2_500,
      modelRetries: 0,
      workerRetries: 0,
      attempts: 1,
    });
    expect(typeof events("job_finished")[0].finalReplyMs).toBe("number");
    expect(events("accepted")[0]).toMatchObject({ seq: 1, duplicate: false });

    // PRIVACY: nothing from the order, the reply, the customer or the products appears anywhere in the logs
    const all = JSON.stringify(lines);
    for (const secret of ["SECRET", "Hoa Lee", "Milo", "tạo invoice", "10 thùng", "Đã tạo"]) expect(all).not.toContain(secret);
  });

  it("acceptance is logged with its commit time and job id only", async () => {
    await say("hello SECRET-ACCEPT");
    expect(events("accepted")[0]).toMatchObject({ seq: 1, duplicate: false });
    expect(JSON.stringify(lines)).not.toContain("SECRET");
  });

  it("failures log a short code and retry counts, never the error message", async () => {
    const { jobId: id } = await say("hi");
    await driveJob(
      id,
      deps(scriptedModel([]), {
        createMessage: async () => {
          throw new Error("upstream said: SECRET-ERR-TEXT for Hoa Lee");
        },
      })
    );
    expect(events("model_call").map((l) => [l.attempt, l.ok, l.reason])).toEqual([[1, false, "error"], [2, false, "error"], [3, false, "error"]]);
    expect(events("model_retry").map((l) => l.action)).toEqual(["retry", "retry"]);
    expect(events("job_failed")[0]).toMatchObject({ reason: "error", retryable: true, modelRetries: 2 });
    expect(JSON.stringify(lines)).not.toContain("SECRET");
  });

  it("the logger redacts anything that is not an identifier or number", () => {
    logJob("x", "job-1", { free: "a sentence with spaces", ok: "anthropic_429", n: 12.345, b: true, u: undefined, name: "Hoa Lee" });
    expect(lines[0]).toMatchObject({ src: "chat-job", event: "x", jobId: "job-1", free: "[redacted]", ok: "anthropic_429", n: 12.3, b: true, u: null, name: "[redacted]" });
  });
});

describe("retries and timeouts respect the time left in the invocation", () => {
  it("a model call's timeout is the smaller of 60s and (time left − finalize reserve)", async () => {
    const a = await say("a");
    const roomy = scriptedModel([[text("ok")]]);
    await driveJob(a.jobId, deps(roomy, { budgetMs: INVOCATION_LIMIT_MS }));
    expect(roomy.timeouts).toEqual([60_000]);

    const b = await say("b");
    const tight = scriptedModel([[text("ok")]]);
    await driveJob(b.jobId, deps(tight, { budgetMs: 50_000 }));
    expect(tight.timeouts).toEqual([50_000 - FINALIZE_RESERVE_MS]);
  });

  it("does not start a model call that cannot fit; hands the job to a fresh invocation without burning an attempt", async () => {
    const { jobId: id } = await say("a");
    const model = scriptedModel([[text("ok")]]);
    const continueJob = vi.fn(async () => true);
    await driveJob(id, deps(model, { budgetMs: FINALIZE_RESERVE_MS + MIN_MODEL_CALL_MS - 1, continueJob }));
    expect(model.calls).toHaveLength(0);
    expect(jobDoc(1)).toMatchObject({ status: "accepted", attempts: 0, deferrals: 1, leaseOwner: null });
    expect(continueJob).toHaveBeenCalledExactlyOnceWith(id);
  });

  it("retries a transient model failure only when another attempt still fits", async () => {
    const flaky = (): { createMessage: RunnerDeps["createMessage"]; n: () => number } => {
      let n = 0;
      const inner = scriptedModel([[text("ok")]]);
      return { n: () => n, createMessage: async (p, o) => { n++; if (n === 1) throw new Error("503"); return inner.createMessage(p, o); } };
    };
    // enough time: retried in place
    const roomy = flaky();
    const a = await say("a");
    const sleep = vi.fn(async () => {});
    await driveJob(a.jobId, deps(roomy, { budgetMs: 80_000, sleep }));
    expect(roomy.n()).toBe(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
    expect(jobDoc(1).status).toBe("completed");

    // not enough time to back off and try again: no in-place retry, hand off (counts as an attempt)
    const tight = flaky();
    const b = await say("b");
    const continueJob = vi.fn(async () => true);
    await driveJob(b.jobId, deps(tight, { budgetMs: FINALIZE_RESERVE_MS + MIN_MODEL_CALL_MS, continueJob }));
    expect(tight.n()).toBe(1);
    expect(jobDoc(2)).toMatchObject({ status: "accepted", attempts: 1 });
    expect(continueJob).toHaveBeenCalledTimes(1);
    expect(events("model_retry").at(-1)).toMatchObject({ action: "defer" });
  });

  it("the SDK is not allowed to retry on its own: one HTTP attempt per model call (retries are ours, and budgeted)", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "x" } }), { status: 529, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(defaultDeps().createMessage({ model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }, { timeoutMs: 5_000 })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a write that committed but reported an error, with no time to retry here, is replayed by the next invocation with no duplicate", async () => {
    const { jobId: id } = await say("tạo invoice");
    const model = scriptedModel([[createDraft()], [text("xong")]]);
    let thrown = false;
    const lostAck: RunnerDeps["executeTool"] = async (n, a, c) => {
      const r = await realExecuteTool(n, a, c); // committed
      if (!thrown) {
        thrown = true;
        throw new Error("UNAVAILABLE after commit");
      }
      return r;
    };
    // the "fresh invocation" is simulated by the hand-off callback driving the job again with a full budget
    const continueJob = vi.fn((jid: string) => driveJob(jid, deps(model, { executeTool: lostAck })).then(() => true));
    await driveJob(id, deps(model, { executeTool: lostAck, budgetMs: FINALIZE_RESERVE_MS + MIN_MODEL_CALL_MS + 1_000, continueJob }));

    expect(continueJob).toHaveBeenCalledTimes(1);
    expect(events("worker_retry")[0]).toMatchObject({ action: "defer" });
    expect(jobDoc(1).status).toBe("completed");
    expect(store.count("invoices")).toBe(1);
    expect(store.read("counters/invoiceCounter")).toEqual({ value: 2000 });
    expect(store.count("invoiceLogs")).toBe(1);
    expect(model.calls).toHaveLength(2);
  });
});

describe("a deferred job continues on its own (no browser, no scheduler)", () => {
  it("hand-off starts a fresh invocation that finishes the job from its checkpoint, exactly once", async () => {
    const { jobId: id } = await say("tạo invoice");
    const model = scriptedModel([[createDraft()], [text("xong")]]);
    const continueJob = vi.fn((jid: string) => driveJob(jid, deps(model)).then(() => true));

    await driveJob(id, deps(model, { budgetMs: -1, continueJob })); // this invocation has no time at all

    expect(continueJob).toHaveBeenCalledExactlyOnceWith(id);
    expect(jobDoc(1).status).toBe("completed");
    expect(store.count("invoices")).toBe(1);
    expect(replyMsg(1)?.content).toBe("xong");
  });

  it("if the hand-off cannot be sent, the job stays safely queued (not failed, nothing lost) for resume/cron to pick up", async () => {
    const { jobId: id } = await say("tạo invoice");
    const model = scriptedModel([[createDraft()], [text("xong")]]);
    for (const continueJob of [async () => false, async () => { throw new Error("network down"); }]) {
      await driveJob(id, deps(model, { budgetMs: -1, continueJob }));
      expect(jobDoc(1).status).toBe("accepted");
    }
    expect(events("hand_off").map((l) => l.dispatched)).toEqual([false, false]);
    // later, the app is opened / a scheduler sweeps: the job completes normally
    await driveJob(id, deps(model));
    expect(jobDoc(1).status).toBe("completed");
    expect(store.count("invoices")).toBe(1);
  });

  it("a job that keeps running out of time stops after MAX_DEFERRALS and asks for a manual retry instead of looping forever", async () => {
    const { jobId: id } = await say("hi");
    const model = scriptedModel([[text("ok")]]);
    for (let i = 0; i < MAX_DEFERRALS; i++) await driveJob(id, deps(model, { budgetMs: -1 }));
    expect(jobDoc(1)).toMatchObject({ status: "accepted", deferrals: MAX_DEFERRALS });
    await driveJob(id, deps(model));
    expect(jobDoc(1)).toMatchObject({ status: "failed", failure: { retryable: true } });
    expect(model.calls).toHaveLength(0);
    await retryJob(wife, id);
    expect(jobDoc(1)).toMatchObject({ status: "accepted", deferrals: 0 });
    await driveJob(id, deps(model));
    expect(jobDoc(1).status).toBe("completed");
  });

  it("does not chain into the next queued job when little time is left — it hands that job off instead of leaving it waiting", async () => {
    const first = await say("first");
    const second = await say("second");
    const model = scriptedModel([[text("one")], [text("two")]]);
    const slow = deps(model, {
      budgetMs: 70_000,
      createMessage: async (p, o) => {
        advance(20_000); // the first job used 20s → 50s left, under the 60s needed to start another job here
        return model.createMessage(p, o);
      },
      continueJob: vi.fn(async () => true),
    });
    await driveJob(first.jobId, slow);
    expect(jobDoc(1).status).toBe("completed");
    expect(jobDoc(2).status).toBe("accepted");
    expect(slow.continueJob).toHaveBeenCalledExactlyOnceWith(second.jobId);
  });
});

describe("hand-off dispatch", () => {
  it("posts to this deployment's own continue endpoint with the secret; sends nothing when unconfigured", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    vi.stubEnv("CRON_SECRET", "");
    expect(await dispatchContinuation("job-1")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("APP_BASE_URL", "https://app.example.com/");
    expect(await dispatchContinuation("main__u__j000001")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app.example.com/api/chat/jobs/main__u__j000001/continue");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer s3cret");
  });

  it("base URL comes only from environment (never from request headers) and prefers the production domain in production", () => {
    vi.stubEnv("APP_BASE_URL", "");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "ai-invoice.example.com");
    vi.stubEnv("VERCEL_URL", "ai-invoice-abc123.vercel.app");
    expect(workerBaseUrl()).toBe("https://ai-invoice.example.com");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(workerBaseUrl()).toBe("https://ai-invoice-abc123.vercel.app");
  });

  it("failed or unreachable dispatch reports false instead of throwing", async () => {
    vi.stubEnv("CRON_SECRET", "s");
    vi.stubEnv("APP_BASE_URL", "https://x.example.com");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    expect(await dispatchContinuation("j")).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await dispatchContinuation("j")).toBe(false);
  });

  it("the continue endpoint requires the server secret and does not reveal whether a job exists to callers without it", async () => {
    const call = (auth?: string) =>
      continueRoute(new NextRequest("http://localhost/api/chat/jobs/x/continue", { method: "POST", headers: auth ? { authorization: auth } : {} }), { params: Promise.resolve({ jobId: "main__wife__j000001" }) });
    vi.stubEnv("CRON_SECRET", "");
    expect((await call("Bearer anything")).status).toBe(503);
    vi.stubEnv("CRON_SECRET", "right");
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect((await call("Bearer right")).status).toBe(404); // authorised, but no such job
    const { jobId: id } = await say("hi");
    await driveJob(id, deps(scriptedModel([[text("ok")]])));
    const done = await continueRoute(new NextRequest("http://localhost/x", { method: "POST", headers: { authorization: "Bearer right" } }), { params: Promise.resolve({ jobId: id }) });
    expect(done.status).toBe(202); // already finished: nothing to drive
    expect(await done.json()).toMatchObject({ status: "completed" });
  });

  it("every route that starts work declares a maxDuration equal to the runner's invocation limit", () => {
    for (const file of ["src/app/api/chat/route.ts", "src/app/api/chat/jobs/[jobId]/resume/route.ts", "src/app/api/chat/jobs/[jobId]/retry/route.ts", "src/app/api/chat/jobs/[jobId]/continue/route.ts", "src/app/api/cron/chat-jobs/route.ts"]) {
      const m = /export const maxDuration = (\d+);/.exec(readFileSync(file, "utf8"));
      expect(m, file).not.toBeNull();
      expect(Number(m![1]) * 1000, file).toBe(INVOCATION_LIMIT_MS);
    }
  });
});

/* --------------------------- bounded read concurrency --------------------------- */

describe("independent read-only tool calls run concurrently, bounded, without changing order or safety", () => {
  const search = (id: string, q = "milo") => toolUse(id, "searchProduct", { query: q });

  /** executeTool that records start/end order and delays reads by `delays[id]` ms. */
  function tracked(delays: Record<string, number> = {}, defaultDelay = 0) {
    const log: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const executeTool: RunnerDeps["executeTool"] = async (name, args, ctx) => {
      const label = name === "createInvoiceDraft" ? "create" : String((args as { query?: string }).query);
      log.push(`start ${label}`);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, delays[label] ?? defaultDelay));
      const result = await realExecuteTool(name, args, ctx);
      inFlight--;
      log.push(`end ${label}`);
      return result;
    };
    return { executeTool, log, maxInFlight: () => maxInFlight };
  }

  it("tool results reach the model, and are checkpointed, in tool_use order even when they finish in a different order", async () => {
    const { jobId: id } = await say("tìm nhiều thứ");
    const ids = ["t1", "t2", "t3", "t4"];
    const qs = ["milo", "bột", "kem", "xyz"];
    const model = scriptedModel([ids.map((i, k) => search(i, qs[k])), [text("xong")]]);
    const run = tracked({ milo: 40, "bột": 30, kem: 20, xyz: 10 }); // last call finishes first

    await driveJob(id, deps(model, { executeTool: run.executeTool }));

    expect(toolResultsInOrder(model.calls[1]).map((r) => r.id)).toEqual(ids);
    // and every result is still paired with ITS OWN call (not just in the right slot)
    const names = toolResultsInOrder(model.calls[1]).map((r) => ((r.result.results as { name: string }[])[0]?.name ?? null));
    expect(names).toEqual(["Milo", "Bột giặt", "Kem đánh răng", null]);
    const saved = (await import("./chatJobs").then((m) => m.loadCheckpoint(id))).toolCalls;
    for (const [i, q] of qs.entries()) {
      const doc = saved.get(ids[i])!;
      expect(JSON.parse(doc.inputJson)).toEqual({ query: q });
      expect(JSON.parse(doc.resultJson).results[0]?.name ?? null).toBe(names[i]);
    }
    expect(run.log.filter((l) => l.startsWith("end"))).toEqual(["end xyz", "end kem", "end bột", "end milo"]); // really out of order
    expect(jobDoc(1).status).toBe("completed");
    expect(jobDoc(1).actions.map((a) => a.tool)).toEqual(Array(4).fill("searchProduct"));
    expect((await import("./chatJobs").then((m) => m.loadCheckpoint(id))).toolCalls.size).toBe(4);
  });

  it(`never runs more than ${READ_CONCURRENCY} at once`, async () => {
    const { jobId: id } = await say("nhiều");
    const uses = Array.from({ length: 9 }, (_, i) => search(`t${i}`, `q${i}`));
    const run = tracked({}, 15);
    await driveJob(id, deps(scriptedModel([uses, [text("xong")]]), { executeTool: run.executeTool }));
    expect(run.maxInFlight()).toBe(READ_CONCURRENCY);
    expect(events("tool_wave")[0]).toMatchObject({ size: 9, concurrency: READ_CONCURRENCY });
  });

  it("is actually faster than sequential (simulated latency — a regression guard, not a live measurement)", async () => {
    const { jobId: id } = await say("nhiều");
    const uses = Array.from({ length: 4 }, (_, i) => search(`t${i}`, `q${i}`));
    const run = tracked({}, 60);
    await driveJob(id, deps(scriptedModel([uses, [text("xong")]]), { executeTool: run.executeTool }));
    const wave = events("tool_wave")[0] as { wallMs: number; sumOfCallsMs: number };
    expect(wave.sumOfCallsMs).toBeGreaterThanOrEqual(4 * 55);
    expect(wave.wallMs).toBeLessThan(wave.sumOfCallsMs * 0.6);
  });

  it("a write is a barrier: reads before it finish first, reads after it start only once it has committed", async () => {
    const { jobId: id } = await say("thứ tự");
    const model = scriptedModel([[search("a", "before-1"), search("b", "before-2"), createDraft("w"), search("c", "after-1"), search("d", "after-2")], [text("xong")]]);
    const run = tracked({}, 15);
    await driveJob(id, deps(model, { executeTool: run.executeTool }));
    const idx = (s: string) => run.log.indexOf(s);
    expect(Math.max(idx("end before-1"), idx("end before-2"))).toBeLessThan(idx("start create"));
    expect(idx("end create")).toBeLessThan(Math.min(idx("start after-1"), idx("start after-2")));
    // the two reads on each side of the write did overlap with each other
    expect(idx("start before-2")).toBeLessThan(idx("end before-1"));
    expect(idx("start after-2")).toBeLessThan(idx("end after-1"));
    expect(store.count("invoices")).toBe(1);
    expect(toolResultsInOrder(model.calls[1]).map((r) => r.id)).toEqual(["a", "b", "w", "c", "d"]);
  });

  it("one failing read does not cancel its siblings; its error is recorded in its own slot", async () => {
    const { jobId: id } = await say("lỗi một phần");
    const model = scriptedModel([[search("a", "ok-1"), search("b", "boom"), search("c", "ok-2")], [text("xong")]]);
    const executeTool: RunnerDeps["executeTool"] = async (n, a, c) => {
      if ((a as { query?: string }).query === "boom") throw new Error("read failed");
      return realExecuteTool(n, a, c);
    };
    await driveJob(id, deps(model, { executeTool }));
    const results = toolResultsInOrder(model.calls[1]);
    expect(results.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(results[1].result).toMatchObject({ status: "error", message: "read failed" });
    expect(results[0].result).toHaveProperty("results");
    expect(results[2].result).toHaveProperty("results");
    expect(jobDoc(1).status).toBe("completed");
  });

  it("requestUserInput after reads: the reads run, then the job waits for her", async () => {
    const { jobId: id } = await say("hỏi lại");
    const model = scriptedModel([[search("a"), search("b", "bột"), toolUse("q", "requestUserInput", { question: "Bạn muốn loại nào?" })]]);
    await driveJob(id, deps(model));
    expect(jobDoc(1).status).toBe("waiting_for_input");
    expect(jobDoc(1).actions.map((a) => a.tool)).toEqual(["searchProduct", "searchProduct", "requestUserInput"]);
    expect(replyMsg(1)?.content).toBe("Bạn muốn loại nào?");
  });

  it("worker dies mid-wave: the takeover re-runs only the reads, the write happens once, and the model is not re-asked", async () => {
    const { jobId: id } = await say("chết giữa chừng");
    const model = scriptedModel([[search("a", "r1"), search("b", "r2"), createDraft("w")], [text("xong")]]);
    const gate = deferred();
    const seen: string[] = [];
    let froze = false;
    const executeTool: RunnerDeps["executeTool"] = async (n, a, c) => {
      const label = n === "createInvoiceDraft" ? "create" : String((a as { query?: string }).query);
      seen.push(label);
      if (label === "r2" && !froze) {
        froze = true;
        await gate.promise; // first worker freezes while the read wave is unfinished (nothing checkpointed yet)
      }
      return realExecuteTool(n, a, c);
    };
    const run1 = driveJob(id, deps(model, { executeTool }));
    await waitFor(() => froze, "worker frozen inside the wave");
    advance(61_000); // lease expires
    await driveJob(id, deps(model, { executeTool }));

    expect(jobDoc(1).status).toBe("completed");
    expect(seen.filter((s) => s === "create")).toHaveLength(1);
    expect(store.count("invoices")).toBe(1);
    expect(store.read("counters/invoiceCounter")).toEqual({ value: 2000 });
    expect(model.calls).toHaveLength(2);

    gate.resolve(); // the frozen worker wakes: it must not write anything more
    await run1;
    expect(seen.filter((s) => s === "create")).toHaveLength(1);
    expect(store.count("invoices")).toBe(1);
    expect(jobDoc(1).status).toBe("completed");
  });
});

describe("prices, totals and confirmations are unaffected by the runner changes (end to end)", () => {
  it("a 10-item order through the runner produces the same invoice and one commit, with catalog/history read once", async () => {
    store.reset();
    seedMembership(wife.uid);
    const { seedShop } = await import("@/test/seedShop");
    const shop = seedShop();
    const { jobId: id } = await say("đơn 10 món");
    const items = Array.from({ length: 10 }, (_, i) => ({ productName: shop.productNames[i * 3], quantity: 2 + (i % 4), price: 20 + (i % 5) }));
    const expectedSubtotal = items.reduce((s, it) => s + Math.round(it.price * it.quantity * 100) / 100, 0);
    const model = scriptedModel([[toolUse("d", "createInvoiceDraft", { customerName: "Hoa Lee", items })], [text("xong")]]);
    store.resetMetrics();
    await driveJob(id, deps(model));
    expect(jobDoc(1).status).toBe("completed");
    const inv = store.list("invoices").map(([, d]) => d).find((d) => d.createdBy === "ai")!;
    expect(inv).toMatchObject({ subtotal: expectedSubtotal, total: expectedSubtotal, paymentStatus: "draft" });
    expect((inv.items as unknown[]).length).toBe(10);
    expect(store.metrics.byCollection.products).toBe(1);
    expect(store.metrics.byCollection.invoices).toBe(1);
  });
});
