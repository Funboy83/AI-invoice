import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("firebase/firestore", async () => (await import("@/test/fakeFirestore")).clientModule);
vi.mock("@/lib/firebase", () => ({ db: {}, firebaseApp: {} }));

import { store } from "@/test/fakeFirestore";
import { createInvoice, recordPayment, updateInvoiceWithLog, createProduct, NotFoundError } from "@/lib/store";
import type { InvoiceLineItem } from "@/lib/types";

const line = (over: Partial<InvoiceLineItem> = {}): InvoiceLineItem => ({
  productId: "p1",
  productName: "Milo",
  quantity: 10,
  unit: "thùng",
  price: 29,
  lineTotal: 290,
  ...over,
});

const base = { customerName: "Hoa Lee", items: [line()], createdBy: "ai" as const, actor: "ai" as const };

beforeEach(() => store.reset());

describe("createInvoice idempotency", () => {
  it("returns the original invoice for a repeated operationId: one invoice, one number, one audit log", async () => {
    const a = await createInvoice({ ...base, operationId: "job1__toolu_1" });
    const b = await createInvoice({ ...base, operationId: "job1__toolu_1" });

    expect(b).toEqual(a);
    expect(a.invoiceNumber).toBe("2000");
    expect(store.count("invoices")).toBe(1);
    expect(store.count("invoiceLogs")).toBe(1);
    expect(store.read("counters/invoiceCounter")).toEqual({ value: 2000 });
    expect(store.list("invoiceLogs")[0][1].operationId).toBe("job1__toolu_1");
  });

  it("different operation ids create distinct invoices with sequential numbers (no gaps, no reuse)", async () => {
    const a = await createInvoice({ ...base, operationId: "op-a" });
    const b = await createInvoice({ ...base, operationId: "op-b" });
    expect([a.invoiceNumber, b.invoiceNumber]).toEqual(["2000", "2001"]);
    expect(store.count("invoices")).toBe(2);
  });

  it("computes money in application code (subtotal + shipping - discount)", async () => {
    const inv = await createInvoice({ ...base, items: [line({ lineTotal: 290 }), line({ productId: "p2", quantity: 3, price: 10.1, lineTotal: 30.3 })], shipping: 15, discount: 5.5, operationId: "op-m" });
    expect(inv.subtotal).toBe(320.3);
    expect(inv.total).toBe(329.8);
    expect(inv.balance).toBe(329.8);
  });

  it("without an operationId behaves as before (each call creates an invoice) — manual UI path unchanged", async () => {
    await createInvoice(base);
    await createInvoice(base);
    expect(store.count("invoices")).toBe(2);
    expect(store.count("operations")).toBe(0);
  });
});

describe("recordPayment idempotency", () => {
  it("applies a payment once no matter how many times the same operation is replayed", async () => {
    const inv = await createInvoice({ ...base, status: "unpaid", operationId: "op-inv" });
    const first = await recordPayment({ invoiceId: inv.id, amount: 100, actor: "ai", operationId: "op-pay" });
    const replay = await recordPayment({ invoiceId: inv.id, amount: 100, actor: "ai", operationId: "op-pay" });

    expect(replay.payment.id).toBe(first.payment.id);
    expect(store.count("payments")).toBe(1);
    const stored = store.read(`invoices/${inv.id}`)!;
    expect(stored.amountPaid).toBe(100);
    expect(stored.balance).toBe(190);
    expect(stored.paymentStatus).toBe("partial");
    // one create log + one payment log
    expect(store.count("invoiceLogs")).toBe(2);
  });

  it("two genuinely different payments both apply", async () => {
    const inv = await createInvoice({ ...base, status: "unpaid", operationId: "op-inv" });
    await recordPayment({ invoiceId: inv.id, amount: 100, actor: "ai", operationId: "pay-1" });
    await recordPayment({ invoiceId: inv.id, amount: 190, actor: "ai", operationId: "pay-2" });
    const stored = store.read(`invoices/${inv.id}`)!;
    expect(stored.amountPaid).toBe(290);
    expect(stored.paymentStatus).toBe("paid");
  });

  it("a missing invoice is a NotFoundError and leaves no ledger entry (so a later retry can still run)", async () => {
    await expect(recordPayment({ invoiceId: "nope", amount: 5, actor: "ai", operationId: "op-x" })).rejects.toBeInstanceOf(NotFoundError);
    expect(store.count("operations")).toBe(0);
    expect(store.count("payments")).toBe(0);
  });
});

describe("updateInvoiceWithLog", () => {
  it("edits computed from the invoice read inside the transaction never lose a concurrent edit", async () => {
    const inv = await createInvoice({ ...base, operationId: "op-inv" });
    const add = (productId: string, opId: string) =>
      updateInvoiceWithLog({
        invoiceId: inv.id,
        items: (before) => [...before.items, line({ productId, productName: productId, quantity: 1, price: 5, lineTotal: 5 })],
        actor: "ai",
        reason: `add ${productId}`,
        operationId: opId,
      });
    await Promise.all([add("pA", "op-a"), add("pB", "op-b")]);

    const stored = store.read(`invoices/${inv.id}`)!;
    expect((stored.items as InvoiceLineItem[]).map((i) => i.productId).sort()).toEqual(["p1", "pA", "pB"]);
    expect(stored.total).toBe(300);
    expect(store.count("invoiceLogs")).toBe(3); // create + 2 edits, each with before/after
  });

  it("replaying the same edit operation does not add the line twice", async () => {
    const inv = await createInvoice({ ...base, operationId: "op-inv" });
    const edit = () =>
      updateInvoiceWithLog({
        invoiceId: inv.id,
        items: (before) => [...before.items, line({ productId: "pZ", lineTotal: 1, price: 1, quantity: 1 })],
        actor: "ai",
        reason: "add pZ",
        operationId: "op-edit",
      });
    await edit();
    await edit();
    expect((store.read(`invoices/${inv.id}`)!.items as unknown[]).length).toBe(2);
    expect(store.count("invoiceLogs")).toBe(2);
  });
});

describe("createProduct idempotency", () => {
  it("creates one product per operation id", async () => {
    const a = await createProduct({ name: "Milo", defaultPrice: 29, operationId: "op-p" });
    const b = await createProduct({ name: "Milo", defaultPrice: 29, operationId: "op-p" });
    expect(b.id).toBe(a.id);
    expect(store.count("products")).toBe(1);
  });
});
