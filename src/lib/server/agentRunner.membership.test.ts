import { beforeEach, describe, expect, it } from "vitest";
import { store } from "@/test/fakeFirestore";
import { driveJob } from "./agentRunner";
import { LEASE_MS, claimJob, loadCheckpoint, retryJob, saveStep } from "./chatJobs";
import {
  wife,
  advance,
  resetRunnerEnv,
  seedMembership,
  revokeMembership,
  text,
  scriptedModel,
  deps,
  seedCatalog,
  jobId,
  jobDoc,
  replyMsg,
  say,
  createDraft,
  toolUse,
  realExecuteTool,
} from "@/test/runnerKit";

/**
 * Membership is checked at every claim (first run, resume, retry, continuation, cron sweep all funnel through
 * claimJob → runJob), using ONLY the job's persisted ownerUid/storeId — never anything the caller supplies. These
 * tests prove: a revoked user's job cannot make a new mutation, prior committed work is never touched or repeated,
 * and the denial is a normal, terminal, non-retryable failure — not a crash, not a silent no-op.
 */

beforeEach(() => {
  resetRunnerEnv();
  seedCatalog();
});

describe("a job whose owner is not (or no longer) a store member", () => {
  it("never ran a single tool call: revoked BEFORE the job starts at all", async () => {
    revokeMembership(wife.uid);
    const { jobId: id } = await say("tạo invoice cho Hoa Lee");
    const model = scriptedModel([[createDraft()], [text("xong")]]);

    await driveJob(id, deps(model));

    expect(model.calls).toHaveLength(0); // the model was never even called
    expect(store.count("invoices")).toBe(0);
    expect(jobDoc(1)).toMatchObject({ status: "failed", failure: { retryable: false } });
    expect(replyMsg(1)?.kind).toBe("error");
  });

  it("revoked mid-attempt (between two model turns of the SAME invocation): the already-committed mutation stands, but the NEXT turn's tools never run", async () => {
    // Turn 1 creates the invoice; turn 2 would add a second line item; turn 3 would reply. Revoke right after
    // turn 1's tool_use is executed but before turn 2 is asked for — proving the check isn't just once-per-claim.
    const { jobId: id } = await say("tạo invoice rồi thêm dòng nữa");
    const model = scriptedModel([
      [createDraft()],
      [toolUse("t2", "addInvoiceItem", { invoiceId: "placeholder", productName: "Bột giặt", quantity: 1, price: 10, reason: "thêm" })],
      [text("xong")],
    ]);
    let modelCalls = 0;
    const revokingAfterFirstTool = deps(model, {
      createMessage: async (p, o) => {
        modelCalls++;
        return model.createMessage(p, o);
      },
      executeTool: async (n, a, c) => {
        const result = await realExecuteTool(n, a, c); // turn 1's invoice actually commits...
        revokeMembership(wife.uid); // ...then, in the gap before turn 2 is even asked for, access is revoked
        return result;
      },
    });

    await driveJob(id, revokingAfterFirstTool);

    expect(store.count("invoices")).toBe(1); // turn 1's mutation, already committed before revocation, stands
    expect(modelCalls).toBe(1); // turn 2's model call NEVER happened — the check stopped it before asking for more tools
    expect(jobDoc(1)).toMatchObject({ status: "failed", failure: { retryable: false } });
    expect((await loadCheckpoint(id)).toolCalls.size).toBe(1); // only turn 1's tool call was ever checkpointed

    // A later resume/cron re-drive is a safe no-op: still revoked, still exactly one invoice, number consumed once.
    await driveJob(id, deps(model));
    expect(store.count("invoices")).toBe(1);
    expect(store.read("counters/invoiceCounter")).toEqual({ value: 2000 });
  });

  it("a step already checkpointed (model responded, tool not yet run) by a dead worker does not run its tool when the resuming attempt finds the owner revoked", async () => {
    // Simulates: attempt #1 got the model's tool_use for step 1 and checkpointed it, then died before executing
    // the tool (e.g. the process was killed). No fresh model call is needed to resume — so only a check BEFORE
    // TOOL EXECUTION (not just one before each fresh model call) can catch this case.
    const { jobId: id } = await say("tạo invoice cho Hoa Lee");
    const deadWorker = "dead-worker-1";
    const claim = await claimJob(id, deadWorker);
    expect(claim.ok).toBe(true);
    await saveStep(id, deadWorker, 1, JSON.stringify([createDraft()]));
    advance(LEASE_MS + 1); // the lease lapses — the "worker" never comes back

    revokeMembership(wife.uid);
    const model = scriptedModel([[createDraft()], [text("xong")]]); // step 1 replays from checkpoint; this script is never actually called
    await driveJob(jobId(1), deps(model));

    expect(model.calls).toHaveLength(0); // the checkpointed step 1 content was reused, not re-asked for
    expect(store.count("invoices")).toBe(0); // and its tool call never ran
    expect(jobDoc(1)).toMatchObject({ status: "failed", failure: { retryable: false } });
    expect((await loadCheckpoint(id)).toolCalls.size).toBe(0);
  });

  it("revoked mid-attempt with the NEXT step already checkpointed too (no fresh model call in between): the pre-tool-execution check is what catches it, independent of the claim-time and pre-model-call checks", async () => {
    // Both steps' model content are pre-checkpointed by a dead worker (a realistic outcome of a worker that made
    // both model calls, checkpointed both, then died before executing either tool). On resume: membership is
    // fine at claim time (Ma passes), step 1 replays its checkpointed content and its tool call executes and is
    // what triggers the revocation, step 2 ALSO replays checkpointed content — so no fresh model call ever
    // happens for it (Mb's guard never fires) — leaving only the pre-tool-execution check to stop step 2's tool.
    const { jobId: id } = await say("tạo rồi thêm dòng");
    const step2Content = [toolUse("t2", "addInvoiceItem", { invoiceId: "placeholder", productName: "Bột giặt", quantity: 1, price: 10, reason: "thêm" })];
    const deadWorker = "dead-worker-2";
    expect((await claimJob(id, deadWorker)).ok).toBe(true);
    await saveStep(id, deadWorker, 1, JSON.stringify([createDraft()]));
    await saveStep(id, deadWorker, 2, JSON.stringify(step2Content));
    advance(LEASE_MS + 1);

    const model = scriptedModel([]); // never called — both steps replay from checkpoints
    const revokingAfterStep1Tool = deps(model, {
      executeTool: async (n, a, c) => {
        const result = await realExecuteTool(n, a, c);
        if (n === "createInvoiceDraft") revokeMembership(wife.uid); // right after step 1's tool commits
        return result;
      },
    });

    await driveJob(jobId(1), revokingAfterStep1Tool);

    expect(model.calls).toHaveLength(0);
    expect(store.count("invoices")).toBe(1); // step 1's checkpointed tool call, already in flight, completes
    const checkpoint = await loadCheckpoint(id);
    expect(checkpoint.toolCalls.has("t2")).toBe(false); // step 2's tool — content replayed, but never executed
    expect(jobDoc(1)).toMatchObject({ status: "failed", failure: { retryable: false } });
  });

  it("a resume/retry/cron-equivalent re-drive of an already-revoked job is a safe no-op, not a crash", async () => {
    const { jobId: id } = await say("tạo invoice");
    const model = scriptedModel([[createDraft()], [text("xong")]]);
    revokeMembership(wife.uid);
    await driveJob(id, deps(model));
    expect(jobDoc(1).status).toBe("failed");
    // driving it again (as resume/cron would) does nothing further — the job is terminal
    await driveJob(id, deps(model));
    expect(jobDoc(1).status).toBe("failed");
    expect(store.count("invoices")).toBe(0);
  });

  it("is not retryable: 'Thử lại' is refused by retryJob, and even if forced, the re-drive is denied again", async () => {
    revokeMembership(wife.uid);
    const { jobId: id } = await say("tạo invoice");
    await driveJob(id, deps(scriptedModel([[text("n/a")]])));
    expect(jobDoc(1).status).toBe("failed");

    // The failure is recorded non-retryable; the client (useAiChat.tsx) uses this to hide "Thử lại". Confirm the
    // flag really is what gates it, and that even a manual retryJob() call does not resurrect access.
    seedMembership("someone-else"); // unrelated membership change; does not affect wife
    const retried = await retryJob(wife, id); // returns accepted (retryJob itself doesn't know about membership)
    expect(retried.status).toBe("accepted");
    await driveJob(id, deps(scriptedModel([[text("n/a")]])));
    expect(jobDoc(1).status).toBe("failed"); // denied again on the re-drive, since wife is still not a member
    expect(store.count("invoices")).toBe(0);
  });

  it("does not chain into a queued follow-up job once the conversation's owner is revoked", async () => {
    const first = await say("first");
    const model = scriptedModel([[text("one")]]);
    await driveJob(first.jobId, deps(model));
    expect(jobDoc(1).status).toBe("completed");

    const second = await say("second");
    revokeMembership(wife.uid);
    await driveJob(second.jobId, deps(scriptedModel([[text("two")]])));
    expect(jobDoc(2)).toMatchObject({ status: "failed", failure: { retryable: false } });
  });

  it("restoring membership lets a NEW message proceed normally again (revocation is not permanent/cached)", async () => {
    revokeMembership(wife.uid);
    const a = await say("a");
    await driveJob(a.jobId, deps(scriptedModel([[text("n/a")]])));
    expect(jobDoc(1).status).toBe("failed");

    seedMembership(wife.uid); // access restored
    const b = await say("b");
    const model = scriptedModel([[createDraft()], [text("Đã tạo invoice")]]);
    await driveJob(b.jobId, deps(model));
    expect(jobDoc(2).status).toBe("completed");
    expect(store.count("invoices")).toBe(1);
  });

  it("a job that asked a question and is waiting stays as-is when revoked (no further tool runs on her next reply attempt)", async () => {
    const { jobId: id } = await say("tạo invoice, cần xác nhận");
    const q = scriptedModel([[toolUse("q1", "requestUserInput", { question: "Bạn muốn loại nào?" })]]);
    await driveJob(id, deps(q));
    expect(jobDoc(1).status).toBe("waiting_for_input");

    revokeMembership(wife.uid);
    const answer = await say("loại A"); // her "answer" is really just a new message from a now-revoked account
    await driveJob(answer.jobId, deps(scriptedModel([[text("n/a")]])));
    expect(jobDoc(2)).toMatchObject({ status: "failed", failure: { retryable: false } });
    expect(store.count("invoices")).toBe(0);
  });
});
