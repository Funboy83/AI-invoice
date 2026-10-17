import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("firebase/firestore", async () => (await import("@/test/fakeFirestore")).clientModule);
vi.mock("@/lib/firebase", () => ({ db: {}, firebaseApp: {} }));

import type Anthropic from "@anthropic-ai/sdk";
import { store } from "@/test/fakeFirestore";
import { ConfigError } from "./firebaseAdmin";
import { LEASE_MS, acceptMessage, retryJob } from "./chatJobs";
import { driveJob } from "./agentRunner";
import { createInvoice } from "@/lib/store";
import {
  wife,
  CID,
  advance,
  resetRunnerEnv,
  text,
  toolUse,
  lastToolResult,
  toolResultsInOrder,
  scriptedModel,
  deps,
  deferred,
  waitFor,
  seedCatalog,
  jobId,
  jobDoc,
  replyMsg,
  userMsg,
  say,
  createDraft,
  realExecuteTool,
  type Step,
} from "@/test/runnerKit";

beforeEach(() => {
  resetRunnerEnv();
  seedCatalog();
});

/* ---------------------------------- tests ---------------------------------- */

describe("normal completion", () => {
  it("runs a request to completion in the background and stores the reply, progress and result", async () => {
    const { jobId: id } = await say("tạo invoice cho Hoa Lee 10 milo 29");
    const model = scriptedModel([[createDraft()], [text("Đã tạo invoice #2000, tổng $290.00")]]);

    await driveJob(id, deps(model));

    expect(jobDoc(1)).toMatchObject({ status: "completed", leaseOwner: null });
    expect(replyMsg(1)).toMatchObject({ role: "assistant", kind: "text", content: "Đã tạo invoice #2000, tổng $290.00" });
    expect(replyMsg(1)?.actions).toEqual([{ tool: "createInvoiceDraft", result: { status: "created" } }]);
    expect(userMsg(1).job).toMatchObject({ status: "completed", actions: [{ tool: "createInvoiceDraft", mutating: true, status: "created" }] });
    expect(store.count("invoices")).toBe(1);
    const inv = store.list("invoices")[0][1];
    expect(inv).toMatchObject({ invoiceNumber: "2000", total: 290, customerName: "Hoa Lee", createdBy: "ai" });
    expect(store.count("invoiceLogs")).toBe(1);
    // the mutation carried a stable operation id: <jobId>__<tool_use id>
    expect(store.list("invoiceLogs")[0][1].operationId).toBe(`${id}__toolu_1`);
  });

  it("sends the conversation history to the model starting with a user turn", async () => {
    const a = await say("first request");
    await driveJob(a.jobId, deps(scriptedModel([[text("first answer")]])));
    await say("second request");
    const model = scriptedModel([[text("second answer")]]);
    await driveJob(jobId(2), deps(model));
    expect(model.calls[0].map((m) => [m.role, m.content])).toEqual([
      ["user", "first request"],
      ["assistant", "first answer"],
      ["user", "second request"],
    ]);
  });
});

describe("retrying the same request", () => {
  it("resending the same requestId and driving twice concurrently runs the job once with no duplicate writes", async () => {
    const a = await acceptMessage(wife, { requestId: "retry-me-please-1", content: "tạo invoice" });
    const b = await acceptMessage(wife, { requestId: "retry-me-please-1", content: "tạo invoice" });
    expect(b.jobId).toBe(a.jobId);
    const model = scriptedModel([[createDraft()], [text("xong")]]);

    await Promise.all([driveJob(a.jobId, deps(model)), driveJob(b.jobId, deps(model))]);

    expect(model.calls).toHaveLength(2); // one run: tool step + final, not doubled
    expect(store.count("invoices")).toBe(1);
    expect(store.count("chatConversations/" + CID + "/messages")).toBe(2);
  });
});

describe("worker interruption", () => {
  it("dies AFTER the invoice is committed but BEFORE the result is checkpointed: takeover creates no second invoice and does not re-ask the model", async () => {
    const { jobId: id } = await say("tạo invoice cho Hoa Lee");
    const model = scriptedModel([[createDraft()], [text("Đã tạo invoice #2000")]]);
    const gate = deferred();
    let first = true;
    const dying = deps(model, {
      executeTool: async (n, a, c) => {
        const r = await realExecuteTool(n, a, c); // the write commits...
        if (first) {
          first = false;
          await gate.promise; // ...then the worker "freezes" before checkpointing the result
        }
        return r;
      },
    });

    const run1 = driveJob(id, dying);
    await waitFor(() => store.count("invoices") === 1, "invoice committed by first worker");
    expect(jobDoc(1).status).toBe("running");
    expect((await import("./chatJobs").then((m) => m.loadCheckpoint(id))).toolCalls.size).toBe(0); // result never saved

    advance(LEASE_MS + 1); // its lease lapses
    await driveJob(id, deps(model)); // a fresh worker (cron / app reopening) takes over

    expect(jobDoc(1)).toMatchObject({ status: "completed", attempts: 2 });
    expect(store.count("invoices")).toBe(1);
    expect(store.read("counters/invoiceCounter")).toEqual({ value: 2000 }); // number consumed once
    expect(store.count("invoiceLogs")).toBe(1);
    expect(model.calls).toHaveLength(2); // step 1 replayed from its checkpoint; only the final answer was generated
    expect(replyMsg(1)?.content).toBe("Đã tạo invoice #2000");

    // The frozen worker wakes up: it must not overwrite or repeat anything.
    gate.resolve();
    await run1;
    expect(store.count("invoices")).toBe(1);
    expect(jobDoc(1).status).toBe("completed");
    expect(replyMsg(1)?.content).toBe("Đã tạo invoice #2000");
    expect(store.count(`chatConversations/${CID}/messages`)).toBe(2);
  });

  it("dies BEFORE the tool ran: takeover runs it once, and even the waking zombie's late attempt is absorbed by the ledger", async () => {
    const { jobId: id } = await say("tạo invoice");
    const model = scriptedModel([[createDraft()], [text("xong")]]);
    const gate = deferred();
    let first = true;
    const dying = deps(model, {
      executeTool: async (n, a, c) => {
        if (first) {
          first = false;
          await gate.promise; // frozen before doing anything
        }
        return realExecuteTool(n, a, c);
      },
    });

    const run1 = driveJob(id, dying);
    await waitFor(() => jobDoc(1).status === "running", "first worker running");
    await waitFor(() => !first, "first worker inside tool");
    advance(LEASE_MS + 1);
    await driveJob(id, deps(model));
    expect(store.count("invoices")).toBe(1);

    gate.resolve(); // zombie now performs the SAME operation id
    await run1;
    expect(store.count("invoices")).toBe(1);
    expect(store.read("counters/invoiceCounter")).toEqual({ value: 2000 });
    expect(store.count("invoiceLogs")).toBe(1);
  });

  it("a lost acknowledgement (write committed, then the call errors) is retried under the same operation id — no duplicate", async () => {
    const { jobId: id } = await say("tạo invoice");
    const model = scriptedModel([[createDraft()], [text("xong")]]);
    let failed = false;
    const flaky = deps(model, {
      executeTool: async (n, a, c) => {
        const r = await realExecuteTool(n, a, c);
        if (!failed) {
          failed = true;
          throw new Error("UNAVAILABLE: connection reset after commit");
        }
        return r;
      },
    });

    await driveJob(id, flaky);

    expect(jobDoc(1).status).toBe("completed");
    expect(store.count("invoices")).toBe(1);
    expect(store.count("invoiceLogs")).toBe(1);
    expect(model.calls).toHaveLength(2);
  });

  it("gives up after repeated worker deaths instead of looping forever, and says what to do", async () => {
    const { jobId: id } = await say("tạo invoice");
    const hang = deps(scriptedModel([]), { createMessage: () => new Promise(() => {}) });
    for (let i = 0; i < 4; i++) {
      void driveJob(id, hang); // each run "dies" while waiting on the model
      await waitFor(() => jobDoc(1).attempts === i + 1, `claim ${i + 1}`);
      advance(LEASE_MS + 1);
    }
    await driveJob(id, deps(scriptedModel([])));
    expect(jobDoc(1)).toMatchObject({ status: "failed", failure: { retryable: true } });
    expect(replyMsg(1)).toMatchObject({ kind: "error", content: expect.stringContaining("Thử lại") });
  });
});

describe("partial failure and retry", () => {
  const payThenFinish: Step[] = [
    [createDraft()],
    (messages) => {
      const invoice = lastToolResult(messages).invoice as { id: string };
      return [toolUse("toolu_2", "recordPayment", { invoiceId: invoice.id, amount: 100, method: "cash" })];
    },
    [text("Đã tạo invoice #2000 và ghi nhận $100")],
  ];

  it("reports what succeeded, saves it, and 'Thử lại' finishes the rest WITHOUT repeating completed work", async () => {
    const { jobId: id } = await say("tạo invoice và ghi nhận thanh toán $100");
    const model = scriptedModel(payThenFinish);
    let outage = true;
    const d = deps(model, {
      executeTool: async (n, a, c) => {
        if (n === "recordPayment" && outage) throw new Error("UNAVAILABLE: firestore down");
        return realExecuteTool(n, a, c);
      },
    });

    await driveJob(id, d);

    // invoice was created, payment was not — and the job says so plainly
    expect(jobDoc(1)).toMatchObject({ status: "failed", failure: { retryable: true } });
    expect(store.count("invoices")).toBe(1);
    expect(store.count("payments")).toBe(0);
    const note = replyMsg(1)!;
    expect(note.kind).toBe("error");
    expect(note.content).toContain("tạo invoice #2000");
    expect(note.content).toContain("Thử lại");
    expect(model.calls).toHaveLength(2); // in-process retries replayed the checkpoint instead of re-asking the model

    // outage over; she taps "Thử lại"
    outage = false;
    expect(await retryJob(wife, id)).toEqual({ status: "accepted" });
    await driveJob(id, d);

    expect(jobDoc(1).status).toBe("completed");
    expect(store.count("invoices")).toBe(1); // NOT recreated
    expect(store.read("counters/invoiceCounter")).toEqual({ value: 2000 });
    expect(store.count("payments")).toBe(1);
    const inv = store.list("invoices")[0][1];
    expect(inv).toMatchObject({ amountPaid: 100, balance: 190, paymentStatus: "partial" });
    expect(model.calls).toHaveLength(3); // only the final answer was newly generated
    expect(replyMsg(1)).toMatchObject({ kind: "text", content: "Đã tạo invoice #2000 và ghi nhận $100" });
  });

  it("a permanent problem (missing config) fails at once, is marked not retryable, and is not retried in a loop", async () => {
    const { jobId: id } = await say("hi");
    const sleep = vi.fn(async () => {});
    await driveJob(
      id,
      deps(scriptedModel([]), {
        sleep,
        createMessage: async () => {
          throw new ConfigError("ANTHROPIC_API_KEY is not configured on the server.");
        },
      })
    );
    expect(sleep).not.toHaveBeenCalled();
    expect(jobDoc(1)).toMatchObject({ status: "failed", failure: { retryable: false } });
    expect(replyMsg(1)?.content).not.toContain("Thử lại");
  });

  it("transient model outages are retried with backoff before failing", async () => {
    const { jobId: id } = await say("hi");
    const sleep = vi.fn(async () => {});
    let calls = 0;
    await driveJob(
      id,
      deps(scriptedModel([]), {
        sleep,
        createMessage: async () => {
          calls++;
          if (calls < 3) throw new Error("503 overloaded");
          return { content: [text("ok")] } as unknown as Anthropic.Messages.Message;
        },
      })
    );
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(jobDoc(1).status).toBe("completed");
  });
});

describe("confirmation rules are preserved", () => {
  it("saves the AI's question, waits for her, and refuses force=true until she has answered", async () => {
    const { jobId: id1 } = await say("thêm sản phẩm Milo giá 30");
    const model1 = scriptedModel([
      [toolUse("toolu_a", "createProduct", { name: "Milo", defaultPrice: 30, force: true })], // AI tries to push through
      [toolUse("toolu_b", "requestUserInput", { question: "Đã có sản phẩm Milo. Bạn muốn dùng Milo cũ hay tạo Milo mới?" })],
    ]);
    await driveJob(id1, deps(model1));

    // the write was blocked, nothing was created, and the job is parked on her answer
    expect(store.count("products")).toBe(3);
    expect(lastToolResult(model1.calls[1])).toMatchObject({ status: "needs_confirmation" });
    expect(jobDoc(1).status).toBe("waiting_for_input");
    expect(replyMsg(1)).toMatchObject({ kind: "question", content: "Đã có sản phẩm Milo. Bạn muốn dùng Milo cũ hay tạo Milo mới?" });
    expect(userMsg(1).job?.status).toBe("waiting_for_input");

    // she answers later; only now is force=true honoured
    const { jobId: id2 } = await say("tạo mới");
    expect(jobDoc(2).canConfirm).toBe(true);
    const model2 = scriptedModel([[toolUse("toolu_c", "createProduct", { name: "Milo", defaultPrice: 30, force: true })], [text("Đã thêm Milo mới")]]);
    await driveJob(id2, deps(model2));
    expect(store.count("products")).toBe(4);
    expect(jobDoc(2).status).toBe("completed");
  });

  it("saves the AI's answer options as tap-to-answer choices on the question", async () => {
    const { jobId } = await say("tạo invoice cho Hoa");
    const model = scriptedModel([
      [toolUse("t1", "requestUserInput", { question: "Chị Hoa nào ạ?", options: ["Hoa Lee – 0909", " Hoa Lee – 0909 ", "Khách mới", 7] })],
    ]);
    await driveJob(jobId, deps(model));
    expect(replyMsg(1)).toMatchObject({ kind: "question", choices: ["Hoa Lee – 0909", "Khách mới"] });
  });

  it("falls back to the similar records a tool found when the AI gives no options", async () => {
    const { jobId } = await say("thêm sản phẩm Milo giá 30");
    const model = scriptedModel([
      [toolUse("t1", "createProduct", { name: "Milo", defaultPrice: 30 })],
      [toolUse("t2", "requestUserInput", { question: "Dùng Milo cũ hay tạo mới?" })],
    ]);
    await driveJob(jobId, deps(model));
    expect(lastToolResult(model.calls[1])).toMatchObject({ status: "needs_confirmation" });
    const choices = replyMsg(1)!.choices as string[];
    expect(choices.length).toBeGreaterThan(0);
    expect(choices[0]).toContain("Milo");
  });

  it("a finished answer has no choices", async () => {
    const { jobId } = await say("chào");
    await driveJob(jobId, deps(scriptedModel([[text("Chào chị")]])));
    expect(replyMsg(1)!.choices).toBeUndefined();
  });

  it("an unrelated later message cannot use force=true even if an old question existed", async () => {
    const { jobId: id1 } = await say("a");
    await driveJob(id1, deps(scriptedModel([[text("ok")]])));
    const { jobId: id2 } = await say("thêm Milo");
    const model = scriptedModel([[toolUse("toolu_x", "createProduct", { name: "Milo", defaultPrice: 30, force: true })], [text("không tạo được")]]);
    await driveJob(id2, deps(model));
    expect(store.count("products")).toBe(3);
    expect(lastToolResult(model.calls[1])).toMatchObject({ status: "needs_confirmation" });
  });

  it("a brand-new product or customer is only previewed until she taps OK in her reply", async () => {
    const customersBefore = store.count("customers");
    const { jobId: id1 } = await say("thêm sản phẩm Xoài sấy giá 12 và khách Zzz Quán Mới");
    const model1 = scriptedModel([
      [
        toolUse("p1", "createProduct", { name: "Xoài sấy", defaultPrice: 12, confirmed: true }), // not her reply yet
        toolUse("c1", "createCustomer", { name: "Zzz Quán Mới", phone: "0909", confirmed: true }),
      ],
      [toolUse("q1", "requestUserInput", { question: "Lưu sản phẩm Xoài sấy $12 và khách Zzz Quán Mới?" })],
    ]);
    await driveJob(id1, deps(model1));
    expect(store.count("products")).toBe(3);
    expect(store.count("customers")).toBe(customersBefore);
    const [productResult, customerResult] = toolResultsInOrder(model1.calls[1]).map((r) => r.result);
    expect(productResult).toMatchObject({ status: "needs_confirmation", preview: { name: "Xoài sấy", defaultPrice: 12 } });
    expect(customerResult).toMatchObject({ status: "needs_confirmation", preview: { name: "Zzz Quán Mới", phone: "0909" } });
    expect((productResult.confirmChoices as string[])[0]).toContain("OK");

    const { jobId: id2 } = await say("OK, lưu");
    const model2 = scriptedModel([
      [
        toolUse("p2", "createProduct", { name: "Xoài sấy", defaultPrice: 12, confirmed: true }),
        toolUse("c2", "createCustomer", { name: "Zzz Quán Mới", phone: "0909", confirmed: true }),
      ],
      [text("Đã lưu")],
    ]);
    await driveJob(id2, deps(model2));
    expect(store.count("products")).toBe(4);
    expect(store.count("customers")).toBe(customersBefore + 1);
  });

  it("if the AI ends its reply right after 'needs_new_customer', the job waits for her instead of claiming completion", async () => {
    const { jobId: id } = await say("tạo invoice cho Khách Lạ 5 milo");
    const model = scriptedModel([
      [toolUse("t1", "createInvoiceDraft", { customerName: "Zzz Khách Lạ", items: [{ productName: "Milo", quantity: 5, price: 29 }] })],
      [text("Mình chưa thấy khách này. Bạn muốn tạo khách mới không?")],
    ]);
    await driveJob(id, deps(model));
    expect(lastToolResult(model.calls[1])).toMatchObject({ status: "needs_new_customer" });
    expect(jobDoc(1).status).toBe("waiting_for_input");
    expect(replyMsg(1)?.kind).toBe("question");
    expect(store.count("invoices")).toBe(0);
  });

  it("never guesses a missing quantity: the invoice is saved as an incomplete draft and the job waits for her", async () => {
    const { jobId: id } = await say("tạo invoice cho Hoa Lee milo");
    const model = scriptedModel([
      [toolUse("t1", "createInvoiceDraft", { customerName: "Hoa Lee", items: [{ productName: "Milo" }] })],
      [text("Thiếu số lượng Milo — bạn cho mình biết nhé?")],
    ]);
    await driveJob(id, deps(model));
    const inv = store.list("invoices")[0][1] as { items: { quantity: number; incomplete?: boolean }[]; total: number };
    expect(inv.items[0]).toMatchObject({ quantity: 0, incomplete: true });
    expect(inv.total).toBe(0);
    expect(jobDoc(1).status).toBe("waiting_for_input");
  });

  it("refuses to add a line with no price when the product has no default price, instead of silently using $0", async () => {
    store.put("products/p9", { name: "Hàng mới", aliases: [], defaultUnit: "cái", defaultPrice: 0, active: true, createdAt: 1, updatedAt: 1 });
    const inv = await createInvoice({ customerName: "Hoa Lee", items: [], createdBy: "ai", actor: "ai", operationId: "seed" });
    const { jobId: id } = await say("thêm hàng mới 3 cái");
    const model = scriptedModel([
      [toolUse("t1", "addInvoiceItem", { invoiceId: inv.id, productName: "Hàng mới", quantity: 3, reason: "add" })],
      [toolUse("t2", "requestUserInput", { question: "Giá của Hàng mới là bao nhiêu?" })],
    ]);
    await driveJob(id, deps(model));
    expect(lastToolResult(model.calls[1])).toMatchObject({ status: "needs_more_info" });
    expect((store.read(`invoices/${inv.id}`)!.items as unknown[]).length).toBe(0);
    expect(jobDoc(1).status).toBe("waiting_for_input");
  });

  it("rejects non-positive payments without touching the invoice", async () => {
    const inv = await createInvoice({ customerName: "Hoa Lee", items: [{ productId: "p1", productName: "Milo", quantity: 1, unit: "thùng", price: 29, lineTotal: 29 }], status: "unpaid", createdBy: "ai", actor: "ai", operationId: "seed" });
    const { jobId: id } = await say("ghi thanh toán -50");
    const model = scriptedModel([[toolUse("t1", "recordPayment", { invoiceId: inv.id, amount: -50 })], [text("Số tiền không hợp lệ")]]);
    await driveJob(id, deps(model));
    expect(lastToolResult(model.calls[1])).toMatchObject({ status: "needs_more_info" });
    expect(store.count("payments")).toBe(0);
    expect(store.read(`invoices/${inv.id}`)).toMatchObject({ amountPaid: 0, balance: 29 });
  });
});

describe("follow-ups while an earlier task is running", () => {
  it("queues the follow-up, runs it strictly after the first, and both edits land with full audit logs", async () => {
    const inv = await createInvoice({ customerName: "Hoa Lee", items: [{ productId: "p1", productName: "Milo", quantity: 10, unit: "thùng", price: 29, lineTotal: 290 }], createdBy: "ai", actor: "ai", operationId: "seed" });
    const first = await say("thêm 2 bột giặt vào invoice");
    const gate = deferred();
    const model = scriptedModel([
      [toolUse("t1", "addInvoiceItem", { invoiceId: inv.id, productName: "Bột giặt", quantity: 2, price: 10, reason: "khách thêm bột giặt" })],
      [text("Đã thêm bột giặt")],
      [toolUse("t2", "addInvoiceItem", { invoiceId: inv.id, productName: "Kem đánh răng", quantity: 3, price: 5, reason: "khách thêm kem" })],
      [text("Đã thêm kem đánh răng")],
    ]);
    const slow = deps(model, {
      createMessage: async (p, o) => {
        if (model.calls.length === 0) await gate.promise; // first job is mid-flight
        return model.createMessage(p, o);
      },
    });

    const run1 = driveJob(first.jobId, slow);
    await waitFor(() => jobDoc(1)?.status === "running", "first job running");

    // she sends a follow-up while the first is still running: accepted right away...
    const second = await say("thêm 3 kem đánh răng nữa");
    expect(second.status).toBe("accepted");
    // ...but a worker that tries to start it now must not (queued behind the first)
    await driveJob(second.jobId, deps(model));
    expect(jobDoc(2).status).toBe("accepted");
    expect(model.calls).toHaveLength(0);

    gate.resolve();
    await run1; // finishing job 1 hands over to job 2 in order

    expect(jobDoc(1).status).toBe("completed");
    expect(jobDoc(2).status).toBe("completed");
    const stored = store.read(`invoices/${inv.id}`)!;
    expect((stored.items as { productName: string }[]).map((i) => i.productName)).toEqual(["Milo", "Bột giặt", "Kem đánh răng"]);
    expect(stored).toMatchObject({ subtotal: 325, total: 325, balance: 325 });
    // audit trail: create + two edits, each with before/after and its operation id
    const logs = store.list("invoiceLogs").map(([, l]) => l);
    expect(logs).toHaveLength(3);
    expect(logs.filter((l) => l.action === "update").map((l) => l.message).sort()).toEqual(["khách thêm bột giặt", "khách thêm kem"]);
    expect(logs.find((l) => l.message === "khách thêm kem")).toMatchObject({ before: { total: 310 }, after: { total: 325 } });
    // the second job saw the first job's reply as context
    expect(JSON.stringify(model.calls[2])).toContain("Đã thêm bột giặt");
  });
});

describe("time budget and misc", () => {
  it("hands the job back when the invocation's time budget is spent, and the next run continues it", async () => {
    const { jobId: id } = await say("tạo invoice");
    const model = scriptedModel([[createDraft()], [text("xong")]]);

    await driveJob(id, deps(model, { budgetMs: -1 }));
    expect(jobDoc(1)).toMatchObject({ status: "accepted", attempts: 0, leaseOwner: null });
    expect(model.calls).toHaveLength(0);

    await driveJob(id, deps(model));
    expect(jobDoc(1).status).toBe("completed");
    expect(store.count("invoices")).toBe(1);
  });

  it("a read-only tool error goes to the model as an ordinary error result; the job carries on", async () => {
    const { jobId: id } = await say("tìm milo");
    const model = scriptedModel([[toolUse("t1", "searchProduct", { query: "milo" })], [text("Không tìm được, thử lại sau")]]);
    await driveJob(
      id,
      deps(model, {
        executeTool: async (n, a, c) => {
          if (n === "searchProduct") throw new Error("boom");
          return realExecuteTool(n, a, c);
        },
      })
    );
    expect(lastToolResult(model.calls[1])).toMatchObject({ status: "error", message: "boom" });
    expect(jobDoc(1).status).toBe("completed");
  });

  it("a domain error from a write (unknown invoice) is reported to the model, not treated as an outage", async () => {
    const { jobId: id } = await say("ghi thanh toán");
    const model = scriptedModel([[toolUse("t1", "recordPayment", { invoiceId: "nope", amount: 5 })], [text("Không thấy invoice đó")]]);
    await driveJob(id, deps(model));
    expect(lastToolResult(model.calls[1])).toMatchObject({ status: "not_found" });
    expect(jobDoc(1).status).toBe("completed");
    expect(store.count("payments")).toBe(0);
  });

  it("stops after the step cap and asks her instead of looping", async () => {
    const { jobId: id } = await say("làm gì đó");
    const loop: Step[] = Array.from({ length: 10 }, (_, i) => [toolUse(`t${i}`, "searchProduct", { query: "milo" })]);
    const model = scriptedModel(loop);
    await driveJob(id, deps(model));
    expect(model.calls).toHaveLength(10);
    expect(jobDoc(1).status).toBe("waiting_for_input");
  });
});
