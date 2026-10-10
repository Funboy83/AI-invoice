/**
 * LIVE model timing for 1-, 5- and 10-item orders (opt-in: `npm run bench:orders`).
 *
 * What is real: the Anthropic API calls (your ANTHROPIC_API_KEY / ANTHROPIC_MODEL from .env.local), the job runner,
 * the tools, checkpoint logic and timing logs. What is NOT: the database is the in-memory fake, so DB time here is ~0 —
 * database latency must be measured separately against Firestore (see the read-only probe in the report). Nothing here
 * touches Firestore or writes to your data. Orders are synthetic text.
 */
import { beforeAll, describe, it, vi } from "vitest";

vi.mock("firebase/firestore", async () => (await import("@/test/fakeFirestore")).clientModule);
vi.mock("@/lib/firebase", () => ({ db: {}, firebaseApp: {} }));

import { store, adminFacade } from "@/test/fakeFirestore";
import { seedShop } from "@/test/seedShop";
import { __setAdminDbForTests } from "@/lib/server/firebaseAdmin";
import { acceptMessage, timeSource } from "@/lib/server/chatJobs";
import { driveJob, defaultDeps } from "@/lib/server/agentRunner";
import { logSink } from "@/lib/server/jobLog";
import type { Firestore } from "firebase-admin/firestore";

const SIZES = (process.env.BENCH_SIZES ?? "1,5,10").split(",").map(Number);
const REPS = Number(process.env.BENCH_REPS ?? 3);
type Line = Record<string, unknown>;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

beforeAll(() => {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    /* env may already be set */
  }
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");
});

describe("live order timing", () => {
  it("measures model / tools / checkpoint / final-reply time by order size", async () => {
    const rows: string[] = [];
    for (const n of SIZES) {
      const per: Record<string, number[]> = { wall: [], model: [], calls: [], tools: [], checkpoints: [], finalReply: [], tail: [], inTok: [], outTok: [], queue: [], toolCalls: [], parallelTurns: [], cpCount: [] };
      for (let rep = 0; rep < REPS; rep++) {
        store.reset();
        timeSource.now = () => Date.now();
        __setAdminDbForTests(adminFacade() as unknown as Firestore);
        const shop = seedShop({ products: 32, customers: 5, invoicesPerCustomer: 2, focusInvoices: 3 }); // sized like the live data
        const lines = Array.from({ length: n }, (_, i) => `${2 + (i % 5)} ${shop.productNames[i * 3]} giá ${20 + (i % 6)}`);
        const text = `Tạo invoice cho Hoa Lee: ${lines.join(", ")}`;
        const captured: Line[] = [];
        logSink.write = (l) => captured.push(JSON.parse(l));
        const { jobId } = await acceptMessage({ uid: "wife", email: "w@example.com", storeId: "main" }, { requestId: `bench-${n}-${rep}-${Date.now()}`, content: text });
        const t0 = performance.now();
        await driveJob(jobId, { ...defaultDeps(), continueJob: async () => false });
        const wall = performance.now() - t0;
        const done = captured.find((l) => l.event === "job_finished") as Line | undefined;
        if (!done) throw new Error(`n=${n} rep=${rep}: job did not finish: ${JSON.stringify(captured.filter((l) => l.event === "job_failed" || l.event === "job_deferred"))}`);
        const claimed = captured.find((l) => l.event === "job_claimed") as Line;
        per.wall.push(wall);
        per.model.push(done.modelMs as number);
        per.calls.push(done.modelCalls as number);
        per.tools.push(done.toolMs as number);
        per.checkpoints.push(done.checkpointMs as number);
        per.cpCount.push(done.checkpoints as number);
        per.finalReply.push(done.finalReplyMs as number);
        per.tail.push((done.tailAfterLastToolMs as number) ?? 0);
        per.inTok.push(done.inputTokens as number);
        per.outTok.push(done.outputTokens as number);
        per.queue.push(claimed.queueMs as number);
        per.toolCalls.push(done.toolCalls as number);
        per.parallelTurns.push(captured.filter((l) => l.event === "model_call" && (l.toolUses as number) > 1).length);
        const tools = captured.filter((l) => l.event === "tool_exec").map((l) => `${l.tool}${l.wave && (l.wave as number) > 1 ? `×${l.wave}` : ""}`).join(",");
        rows.push(`  n=${String(n).padStart(2)} rep=${rep} status=${done.status} wall=${wall.toFixed(0)}ms model=${(done.modelMs as number).toFixed(0)}ms calls=${done.modelCalls} finalReply=${(done.finalReplyMs as number).toFixed(0)}ms(${done.finalReplyTokens}tok) tools=${(done.toolMs as number).toFixed(0)}ms checkpoints=${done.checkpoints}/${(done.checkpointMs as number).toFixed(0)}ms tokens in/out=${done.inputTokens}/${done.outputTokens} cacheRead=${done.cacheReadTokens} toolSeq=[${tools}]`);
        for (const c of captured.filter((l) => l.event === "model_call")) {
          rows.push(`      call ${c.step}: ${(c.ms as number).toFixed(0)}ms in=${c.inputTokens} out=${c.outputTokens} cacheRead=${c.cacheReadTokens} toolUses=${c.toolUses}`);
        }
        for (const w of captured.filter((l) => l.event === "tool_wave")) {
          rows.push(`      read wave step ${w.step}: ${w.size} calls, concurrency ${w.concurrency}, wall=${(w.wallMs as number).toFixed(0)}ms (fake DB)`);
        }
        // sanity: the invoice really has n lines and correct total
        const inv = store.list("invoices").map(([, d]) => d).find((d) => d.createdBy === "ai");
        if (!inv || (inv.items as unknown[]).length !== n) rows.push(`  !! n=${n} rep=${rep}: invoice lines=${inv ? (inv.items as unknown[]).length : "none"} (status=${done.status})`);
      }
      rows.push(`SUMMARY n=${n} (median of ${REPS}): wall=${med(per.wall).toFixed(0)}ms | model=${med(per.model).toFixed(0)}ms in ${med(per.calls)} calls | final-reply call=${med(per.finalReply).toFixed(0)}ms | tools(fake DB)=${med(per.tools).toFixed(0)}ms | checkpoints(fake DB)=${med(per.checkpoints).toFixed(0)}ms (${med(per.cpCount)} writes) | queue=${med(per.queue).toFixed(0)}ms | tokens in/out=${med(per.inTok)}/${med(per.outTok)} | modelShareOfWall=${((med(per.model) / med(per.wall)) * 100).toFixed(0)}%`);
      void sum;
    }
    console.log("\n=== LIVE MODEL TIMING (model=real API, DB=in-memory fake) ===\n" + rows.join("\n") + "\n");
  });
});

/**
 * SIMULATED (no model, no Firestore): the effect of bounded read concurrency when each read costs a fixed round trip.
 * READ_RTT_MS defaults to 45ms, the warm read latency measured against the live Firestore from a developer machine.
 * `sequential` is the sum of the individual calls (what running them one after another would take); `wave` is the
 * measured wall time of the concurrent wave in the same run.
 */
describe("simulated read-wave gain", () => {
  it("prints wall vs sequential for the lookup turn a real order produces (items + 1 reads)", async () => {
    const { toolUse, text, scriptedModel, deps } = await import("@/test/runnerKit");
    const { executeTool } = await import("@/lib/ai/tools");
    const rtt = Number(process.env.READ_RTT_MS ?? 45);
    const out: string[] = [];
    for (const items of [1, 5, 10]) {
      store.reset();
      timeSource.now = () => Date.now();
      __setAdminDbForTests(adminFacade() as unknown as Firestore);
      seedShop({ products: 32, customers: 5, invoicesPerCustomer: 2, focusInvoices: 3 });
      const captured: Line[] = [];
      logSink.write = (l) => captured.push(JSON.parse(l));
      const { jobId } = await acceptMessage({ uid: "wife", email: "w@example.com", storeId: "main" }, { requestId: `sim-${items}-${Date.now()}`, content: "x" });
      const reads = [toolUse("c", "searchCustomer", { query: "Hoa Lee" }), ...Array.from({ length: items }, (_, i) => toolUse(`p${i}`, "searchProduct", { query: `Milo ${i}` }))];
      const model = scriptedModel([reads, [text("xong")]]);
      await driveJob(jobId, deps(model, { executeTool: async (n, a, c) => { await new Promise((r) => setTimeout(r, rtt)); return executeTool(n, a, c); } }));
      const w = captured.find((l) => l.event === "tool_wave") as Line;
      out.push(`  ${String(items).padStart(2)} items → ${w.size} reads @${rtt}ms: sequential≈${(w.sumOfCallsMs as number).toFixed(0)}ms, bounded-concurrent(${w.concurrency})=${(w.wallMs as number).toFixed(0)}ms, saved≈${((w.sumOfCallsMs as number) - (w.wallMs as number)).toFixed(0)}ms`);
    }
    console.log("\n=== SIMULATED read-wave gain (latency injected; not a live measurement) ===\n" + out.join("\n") + "\n");
  });
});
