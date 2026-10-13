import { beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { store, adminFacade } from "@/test/fakeFirestore";
import { __setAdminDbForTests } from "./firebaseAdmin";
import {
  createInvoice,
  recordPayment,
  recordCustomerPayment,
  updateInvoiceWithLog,
  createProduct,
  updateProduct,
  createCustomer,
  copyInvoice,
  getProductsByIds,
  getInvoicesForCustomer,
  getCustomerDebt,
  NotFoundError,
} from "./businessStore";
import { OperationConflictError, ValidationError } from "@/lib/domainErrors";
import type { InvoiceLineItem } from "@/lib/types";

/**
 * Admin-SDK mirror of src/lib/store.idempotency.test.ts, proving businessStore.ts — used by BOTH the AI (via
 * tools.ts) and the manual /api/business/* routes — preserves the exact same transactional/idempotent guarantees,
 * totals, and Task A serialization as the client-SDK path, since they share invoiceMath.ts/domainErrors.ts.
 */

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

beforeEach(() => {
  store.reset();
  __setAdminDbForTests(adminFacade() as unknown as Firestore);
});

describe("createInvoice idempotency (Admin path)", () => {
  it("returns the original invoice for a repeated operationId: one invoice, one number, one audit log", async () => {
    const a = await createInvoice({ ...base, operationId: "job1__toolu_1" });
    const b = await createInvoice({ ...base, operationId: "job1__toolu_1" });
    expect(b).toEqual(a);
    expect(a.invoiceNumber).toBe("2000");
    expect(store.count("invoices")).toBe(1);
    expect(store.count("invoiceLogs")).toBe(1);
    expect(store.read("counters/invoiceCounter")).toEqual({ value: 2000 });
  });

  it("different operation ids create distinct invoices with sequential numbers", async () => {
    const a = await createInvoice({ ...base, operationId: "op-a" });
    const b = await createInvoice({ ...base, operationId: "op-b" });
    expect([a.invoiceNumber, b.invoiceNumber]).toEqual(["2000", "2001"]);
  });

  it("computes money in application code (subtotal + shipping - discount), matching the client path exactly", async () => {
    const inv = await createInvoice({
      ...base,
      items: [line({ lineTotal: 290 }), line({ productId: "p2", quantity: 3, price: 10.1, lineTotal: 30.3 })],
      shipping: 15,
      discount: 5.5,
      operationId: "op-m",
    });
    expect(inv.subtotal).toBe(320.3);
    expect(inv.total).toBe(329.8);
  });

  it("applies Task A's fix: a line item with an undefined optional field is stored without that key", async () => {
    const inv = await createInvoice({ ...base, items: [line({ barcode: undefined, productId: undefined })], operationId: "op-barcode" });
    const stored = store.read(`invoices/${inv.id}`)!;
    const storedItem = (stored.items as Record<string, unknown>[])[0];
    expect(storedItem).not.toHaveProperty("barcode");
    expect(storedItem).not.toHaveProperty("productId");
  });
});

describe("recordPayment idempotency (Admin path)", () => {
  it("applies a payment once no matter how many times the operation is replayed", async () => {
    const inv = await createInvoice({ ...base, status: "unpaid", operationId: "op-inv" });
    const first = await recordPayment({ invoiceId: inv.id, amount: 100, actor: "ai", operationId: "op-pay" });
    const replay = await recordPayment({ invoiceId: inv.id, amount: 100, actor: "ai", operationId: "op-pay" });
    expect(replay.payment.id).toBe(first.payment.id);
    expect(store.count("payments")).toBe(1);
    const stored = store.read(`invoices/${inv.id}`)!;
    expect(stored).toMatchObject({ amountPaid: 100, balance: 190, paymentStatus: "partial" });
  });

  it("a missing invoice is a NotFoundError and leaves no ledger entry", async () => {
    await expect(recordPayment({ invoiceId: "nope", amount: 5, actor: "ai", operationId: "op-x" })).rejects.toBeInstanceOf(NotFoundError);
    expect(store.count("operations")).toBe(0);
    expect(store.count("payments")).toBe(0);
  });
});

describe("updateInvoiceWithLog (Admin path)", () => {
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
    expect(store.count("invoiceLogs")).toBe(3);
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
  });
});

describe("createProduct / createCustomer idempotency (Admin path)", () => {
  it("creates one product per operation id, using Admin SDK auto-generated doc ids", async () => {
    const a = await createProduct({ name: "Milo", defaultPrice: 29, operationId: "op-p" });
    const b = await createProduct({ name: "Milo", defaultPrice: 29, operationId: "op-p" });
    expect(b.id).toBe(a.id);
    expect(store.count("products")).toBe(1);
    expect(a.id).not.toBe(""); // auto-id actually generated, not the literal "undefined" bug
    expect(a.id).not.toContain("undefined");
  });

  it("creates one customer per operation id", async () => {
    const a = await createCustomer({ name: "Hoa Lee", operationId: "op-c" });
    const b = await createCustomer({ name: "Hoa Lee", operationId: "op-c" });
    expect(b.id).toBe(a.id);
    expect(store.count("customers")).toBe(1);
  });
});

describe("copyInvoice idempotency (Admin path)", () => {
  it("replaying the same operation id returns the same copy, not a second one", async () => {
    const original = await createInvoice({ ...base, operationId: "op-orig" });
    const a = await copyInvoice({ sourceInvoiceId: original.id, actor: "ai", operationId: "op-copy" });
    const b = await copyInvoice({ sourceInvoiceId: original.id, actor: "ai", operationId: "op-copy" });
    expect(b.id).toBe(a.id);
    expect(store.count("invoices")).toBe(2); // original + one copy, never a third
  });
});

describe("batched / scoped reads (Admin path)", () => {
  it("getProductsByIds batches ids and ignores unknown ones", async () => {
    for (let i = 0; i < 35; i++) store.put(`products/q${i}`, { name: `P${i}`, aliases: [], defaultUnit: "u", defaultPrice: 1, active: true, createdAt: 1, updatedAt: 1 });
    const got = await getProductsByIds([...Array.from({ length: 35 }, (_, i) => `q${i}`), "missing"]);
    expect(got.size).toBe(35);
    expect(got.has("missing")).toBe(false);
  });

  it("getInvoicesForCustomer and getCustomerDebt only ever touch that customer's invoices", async () => {
    await createInvoice({ customerId: "c1", customerName: "A", items: [line()], status: "unpaid", createdBy: "ai", actor: "ai", operationId: "i1" });
    await createInvoice({ customerId: "c2", customerName: "B", items: [line()], status: "unpaid", createdBy: "ai", actor: "ai", operationId: "i2" });
    const list = await getInvoicesForCustomer("c1");
    expect(list).toHaveLength(1);
    expect(list[0].customerId).toBe("c1");
    const debt = await getCustomerDebt("c1");
    expect(debt.balance).toBe(290);
    expect(debt.openInvoices).toHaveLength(1);
  });
});

describe("B1 — stable retry keys survive a lost response, without duplicating, and reject a reused key under different input", () => {
  it("createInvoice: commit-then-lost-response, then the CLIENT retries with the SAME key — exactly one invoice/number/log; a genuinely new payment still applies", async () => {
    const key = "client-attempt-abc123";
    const first = await createInvoice({ ...base, operationId: key });
    // Simulates the exact client shape from src/lib/useActionId.ts: the browser never saw the response, so it
    // resubmits with the identical stable id it already had for this action.
    const retry = await createInvoice({ ...base, operationId: key });
    expect(retry).toEqual(first);
    expect(store.count("invoices")).toBe(1);
    expect(store.count("invoiceLogs")).toBe(1);
    expect(store.read("counters/invoiceCounter")).toEqual({ value: 2000 });

    // A DELIBERATE new payment (its own fresh key, exactly as opening the payment dialog again would produce) still applies.
    const paid = await recordPayment({ invoiceId: first.id, amount: 100, actor: "user", operationId: "pay-key-1" });
    expect(paid.invoice.amountPaid).toBe(100);
    const paidAgain = await recordPayment({ invoiceId: first.id, amount: 50, actor: "user", operationId: "pay-key-2" });
    expect(paidAgain.invoice.amountPaid).toBe(150);
    expect(store.count("payments")).toBe(2);
  });

  it("recordPayment: commit-then-lost-response, then retried with the SAME key — exactly one payment/balance update", async () => {
    const inv = await createInvoice({ ...base, status: "unpaid", operationId: "seed-inv" });
    const key = "pay-attempt-xyz";
    const first = await recordPayment({ invoiceId: inv.id, amount: 40, actor: "user", operationId: key });
    const retry = await recordPayment({ invoiceId: inv.id, amount: 40, actor: "user", operationId: key });
    expect(retry).toEqual(first);
    expect(store.count("payments")).toBe(1);
    expect(store.read(`invoices/${inv.id}`)).toMatchObject({ amountPaid: 40, balance: 250 });
  });

  it("updateInvoiceWithLog (the manual edit route's array-items shape): retried with the SAME key applies once", async () => {
    const inv = await createInvoice({ ...base, operationId: "seed-inv-2" });
    const key = "edit-attempt-1";
    const edit = () => updateInvoiceWithLog({ invoiceId: inv.id, items: [line({ quantity: 5, price: 10, lineTotal: 50 })], actor: "user", reason: "fix qty", operationId: key });
    const first = await edit();
    const retry = await edit();
    expect(retry).toEqual(first);
    expect(store.count("invoiceLogs")).toBe(2); // create + exactly one edit, not two
  });

  it("a key reused for a DIFFERENT createInvoice payload is rejected (409-mapped OperationConflictError), not silently returned as if it matched", async () => {
    const key = "collide-1";
    await createInvoice({ ...base, operationId: key });
    await expect(createInvoice({ ...base, customerName: "A Totally Different Customer", operationId: key })).rejects.toBeInstanceOf(OperationConflictError);
    expect(store.count("invoices")).toBe(1); // the second, mismatched attempt created nothing
  });

  it("a key reused for a DIFFERENT recordPayment amount is rejected, not silently applied as the first amount", async () => {
    const inv = await createInvoice({ ...base, status: "unpaid", operationId: "seed-inv-3" });
    const key = "pay-collide-1";
    await recordPayment({ invoiceId: inv.id, amount: 20, actor: "user", operationId: key });
    await expect(recordPayment({ invoiceId: inv.id, amount: 999, actor: "user", operationId: key })).rejects.toBeInstanceOf(OperationConflictError);
    expect(store.count("payments")).toBe(1);
    expect(store.read(`invoices/${inv.id}`)).toMatchObject({ amountPaid: 20 }); // the mismatched 999 never applied
  });

  it("a key reused across genuinely different TOOLS (createInvoice vs createProduct) is rejected, not cross-matched", async () => {
    const key = "cross-tool-1";
    await createInvoice({ ...base, operationId: key });
    await expect(createProduct({ name: "Something", defaultPrice: 5, operationId: key })).rejects.toBeInstanceOf(OperationConflictError);
    expect(store.count("products")).toBe(0);
  });
});

describe("B2 — financial invariants enforced at the shared businessStore boundary (protects AI tool calls AND manual routes alike)", () => {
  it("createInvoice rejects a negative or non-finite unit price, with NO invoice/counter/log write", async () => {
    for (const price of [-1, NaN, Infinity, -Infinity]) {
      await expect(createInvoice({ ...base, items: [line({ price, lineTotal: price * 10 })], operationId: `bad-price-${price}` })).rejects.toBeInstanceOf(ValidationError);
    }
    expect(store.count("invoices")).toBe(0);
    expect(store.read("counters/invoiceCounter")).toBeUndefined();
    expect(store.count("invoiceLogs")).toBe(0);
  });

  it("createInvoice rejects a negative or non-finite (e.g. Infinity) quantity, with no write", async () => {
    for (const quantity of [-5, Infinity]) {
      await expect(createInvoice({ ...base, items: [line({ quantity, lineTotal: 29 * quantity })], operationId: `bad-qty-${quantity}` })).rejects.toBeInstanceOf(ValidationError);
    }
    expect(store.count("invoices")).toBe(0);
  });

  it("createInvoice rejects non-finite shipping/discount", async () => {
    await expect(createInvoice({ ...base, shipping: NaN, operationId: "bad-ship" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createInvoice({ ...base, discount: Infinity, operationId: "bad-disc" })).rejects.toBeInstanceOf(ValidationError);
    expect(store.count("invoices")).toBe(0);
  });

  it("PRESERVES a legitimate incomplete AI draft: quantity 0 and/or price 0, incomplete: true — still writes normally", async () => {
    const inv = await createInvoice({ ...base, items: [line({ quantity: 0, price: 0, lineTotal: 0, incomplete: true })], operationId: "legit-incomplete" });
    expect(inv.items[0]).toMatchObject({ quantity: 0, price: 0, incomplete: true });
    expect(inv.total).toBe(0);
    expect(store.count("invoices")).toBe(1);
  });

  it("recomputes lineTotal from quantity*price rather than trusting a forged/wrong one", async () => {
    const inv = await createInvoice({ ...base, items: [line({ quantity: 3, price: 10, lineTotal: 999999 })], operationId: "forged-total" });
    expect(inv.items[0].lineTotal).toBe(30);
    expect(inv.subtotal).toBe(30);
  });

  it("updateInvoiceWithLog rejects an invalid price/quantity in a plain array (the manual edit route's shape), with no write", async () => {
    const inv = await createInvoice({ ...base, operationId: "seed-b2-1" });
    await expect(
      updateInvoiceWithLog({ invoiceId: inv.id, items: [line({ price: -1 })], actor: "user", reason: "x", operationId: "bad-edit-1" })
    ).rejects.toBeInstanceOf(ValidationError);
    expect(store.read(`invoices/${inv.id}`)).toMatchObject({ total: 290 }); // unchanged
    expect(store.count("invoiceLogs")).toBe(1); // only the original create — the bad edit left no log
  });

  it("updateInvoiceWithLog rejects invalid quantity/price coming from a FUNCTION items resolver (the AI's addInvoiceItem/updateInvoiceItem shape)", async () => {
    const inv = await createInvoice({ ...base, operationId: "seed-b2-2" });
    await expect(
      updateInvoiceWithLog({
        invoiceId: inv.id,
        items: (before) => [...before.items, line({ productId: "p2", quantity: Infinity, price: 1, lineTotal: Infinity })],
        actor: "ai",
        reason: "bad ai edit",
        operationId: "bad-edit-2",
      })
    ).rejects.toBeInstanceOf(ValidationError);
    expect((store.read(`invoices/${inv.id}`)!.items as unknown[]).length).toBe(1); // still just the original line
  });

  it("recordPayment rejects a non-positive or non-finite amount, with no write (regression: was already checked, still enforced at this shared boundary)", async () => {
    const inv = await createInvoice({ ...base, status: "unpaid", operationId: "seed-b2-3" });
    for (const amount of [0, -10, NaN, Infinity]) {
      await expect(recordPayment({ invoiceId: inv.id, amount, actor: "user", operationId: `bad-pay-${amount}` })).rejects.toBeInstanceOf(ValidationError);
    }
    expect(store.count("payments")).toBe(0);
    expect(store.read(`invoices/${inv.id}`)).toMatchObject({ amountPaid: 0 });
  });

  it("createProduct/updateProduct reject a negative defaultPrice/cost — this is the AI createProduct tool's own path, which had NO validation before", async () => {
    await expect(createProduct({ name: "X", defaultPrice: -1, operationId: "bad-prod-1" })).rejects.toBeInstanceOf(ValidationError);
    await expect(createProduct({ name: "X", defaultPrice: 5, cost: -1, operationId: "bad-prod-2" })).rejects.toBeInstanceOf(ValidationError);
    expect(store.count("products")).toBe(0);
    const p = await createProduct({ name: "Good", defaultPrice: 10, operationId: "ok-prod" });
    await expect(updateProduct(p.id, { defaultPrice: Infinity }, "bad-prod-3")).rejects.toBeInstanceOf(ValidationError);
    expect(store.read(`products/${p.id}`)).toMatchObject({ defaultPrice: 10 }); // unchanged
  });

  it("valid draft/edit/payment cases from the existing suite are unaffected (spot regression check)", async () => {
    const inv = await createInvoice({ customerName: "Hoa Lee", items: [line({ lineTotal: 290 }), line({ productId: "p2", quantity: 3, price: 10.1, lineTotal: 30.3 })], shipping: 15, discount: 5.5, operationId: "regress-1", createdBy: "ai", actor: "ai" });
    expect(inv.subtotal).toBe(320.3);
    expect(inv.total).toBe(329.8);
  });
});

describe("stock deduction — tracked (quantity set) vs untracked (quantity omitted) products", () => {
  const seedTracked = (id: string, quantity: number) => store.put(`products/${id}`, { name: id, aliases: [], defaultUnit: "u", defaultPrice: 1, quantity, active: true, createdAt: 1, updatedAt: 1 });
  const seedUntracked = (id: string) => store.put(`products/${id}`, { name: id, aliases: [], defaultUnit: "u", defaultPrice: 1, active: true, createdAt: 1, updatedAt: 1 });

  it("a DRAFT invoice never touches stock, even though a tracked product is referenced", async () => {
    seedTracked("p1", 100);
    await createInvoice({ ...base, status: "draft", operationId: "draft-1" });
    expect(store.read("products/p1")).toMatchObject({ quantity: 100 });
  });

  it("creating a manual (status: unpaid) invoice deducts a tracked product's stock immediately", async () => {
    seedTracked("p1", 100);
    const inv = await createInvoice({ ...base, status: "unpaid", operationId: "unpaid-1" });
    expect(store.read("products/p1")).toMatchObject({ quantity: 90 }); // 100 - 10
    expect(inv.deductedQuantities).toEqual([{ productId: "p1", quantity: 10 }]);
  });

  it("an untracked product (no quantity field) is never written to, and never appears in deductedQuantities", async () => {
    seedUntracked("p1");
    const inv = await createInvoice({ ...base, status: "unpaid", operationId: "untracked-1" });
    expect(store.read("products/p1")).not.toHaveProperty("quantity");
    expect(inv.deductedQuantities ?? []).toEqual([]);
  });

  it("finalizing a draft invoice (draft -> unpaid) deducts stock exactly once", async () => {
    seedTracked("p1", 100);
    const inv = await createInvoice({ ...base, status: "draft", operationId: "seed-fin-1" });
    expect(store.read("products/p1")).toMatchObject({ quantity: 100 });
    const updated = await updateInvoiceWithLog({ invoiceId: inv.id, status: "unpaid", actor: "ai", reason: "Invoice finalized", operationId: "finalize-1" });
    expect(store.read("products/p1")).toMatchObject({ quantity: 90 });
    expect(updated.deductedQuantities).toEqual([{ productId: "p1", quantity: 10 }]);
  });

  it("increasing quantity on an already-committed invoice deducts only the delta", async () => {
    seedTracked("p1", 100);
    const inv = await createInvoice({ ...base, status: "unpaid", operationId: "seed-inc-1" });
    expect(store.read("products/p1")).toMatchObject({ quantity: 90 });
    await updateInvoiceWithLog({
      invoiceId: inv.id,
      items: [line({ quantity: 14, lineTotal: 14 * 29 })],
      actor: "user",
      reason: "qty change",
      operationId: "inc-edit-1",
    });
    expect(store.read("products/p1")).toMatchObject({ quantity: 86 }); // 100 - 14
  });

  it("removing a line item from a committed invoice restores that product's stock", async () => {
    seedTracked("p1", 100);
    seedTracked("p2", 50);
    const inv = await createInvoice({
      ...base,
      status: "unpaid",
      items: [line(), line({ productId: "p2", quantity: 5, price: 10, lineTotal: 50 })],
      operationId: "seed-rm-1",
    });
    expect(store.read("products/p1")).toMatchObject({ quantity: 90 });
    expect(store.read("products/p2")).toMatchObject({ quantity: 45 });
    await updateInvoiceWithLog({
      invoiceId: inv.id,
      items: (before) => before.items.filter((i) => i.productId !== "p2"),
      actor: "ai",
      reason: "removed p2",
      operationId: "rm-edit-1",
    });
    expect(store.read("products/p2")).toMatchObject({ quantity: 50 }); // fully restored
    expect(store.read("products/p1")).toMatchObject({ quantity: 90 }); // untouched
  });

  it("voiding a committed invoice restores everything it had deducted", async () => {
    seedTracked("p1", 100);
    const inv = await createInvoice({ ...base, status: "unpaid", operationId: "seed-void-1" });
    expect(store.read("products/p1")).toMatchObject({ quantity: 90 });
    const voided = await updateInvoiceWithLog({ invoiceId: inv.id, status: "void", actor: "user", reason: "customer cancelled", operationId: "void-1" });
    expect(store.read("products/p1")).toMatchObject({ quantity: 100 });
    expect(voided.deductedQuantities ?? []).toEqual([]);
  });

  it("voiding a draft (never-committed) invoice is a stock no-op", async () => {
    seedTracked("p1", 100);
    const inv = await createInvoice({ ...base, status: "draft", operationId: "seed-void-draft-1" });
    await updateInvoiceWithLog({ invoiceId: inv.id, status: "void", actor: "user", reason: "bad order", operationId: "void-draft-1" });
    expect(store.read("products/p1")).toMatchObject({ quantity: 100 }); // never moved
  });

  it("editing line items on a still-draft invoice never touches stock", async () => {
    seedTracked("p1", 100);
    const inv = await createInvoice({ ...base, status: "draft", operationId: "seed-draft-edit-1" });
    await updateInvoiceWithLog({
      invoiceId: inv.id,
      items: [line({ quantity: 50, lineTotal: 50 * 29 })],
      actor: "ai",
      reason: "fixing incomplete draft",
      operationId: "draft-edit-1",
    });
    expect(store.read("products/p1")).toMatchObject({ quantity: 100 }); // still untouched
  });

  it("recording a payment against a still-draft invoice commits it and deducts stock", async () => {
    seedTracked("p1", 100);
    const inv = await createInvoice({ ...base, status: "draft", operationId: "seed-pay-draft-1" });
    expect(store.read("products/p1")).toMatchObject({ quantity: 100 });
    await recordPayment({ invoiceId: inv.id, amount: 50, actor: "user", operationId: "pay-draft-1" });
    expect(store.read("products/p1")).toMatchObject({ quantity: 90 });
  });

  it("recording a payment on an already-committed invoice does not re-deduct or duplicate stock", async () => {
    seedTracked("p1", 100);
    const inv = await createInvoice({ ...base, status: "unpaid", operationId: "seed-pay-committed-1" });
    expect(store.read("products/p1")).toMatchObject({ quantity: 90 });
    await recordPayment({ invoiceId: inv.id, amount: 100, actor: "user", operationId: "pay-committed-1" });
    expect(store.read("products/p1")).toMatchObject({ quantity: 90 }); // unchanged, not deducted again
  });

  it("deducting below zero is allowed (warn, don't block) and is reported via stockWarnings", async () => {
    seedTracked("p1", 3);
    const inv = await createInvoice({ ...base, status: "unpaid", operationId: "seed-neg-1" }); // orders 10, only 3 in stock
    expect(store.read("products/p1")).toMatchObject({ quantity: -7 });
    expect(inv.stockWarnings?.[0]).toMatch(/stock is now -7/);
  });

  it("re-finalizing via a replayed operationId does not double-deduct", async () => {
    seedTracked("p1", 100);
    const inv = await createInvoice({ ...base, status: "draft", operationId: "seed-replay-1" });
    const key = "finalize-replay-1";
    const first = await updateInvoiceWithLog({ invoiceId: inv.id, status: "unpaid", actor: "ai", reason: "Invoice finalized", operationId: key });
    const replay = await updateInvoiceWithLog({ invoiceId: inv.id, status: "unpaid", actor: "ai", reason: "Invoice finalized", operationId: key });
    expect(replay).toEqual(first);
    expect(store.read("products/p1")).toMatchObject({ quantity: 90 });
  });
});

describe("recordCustomerPayment — one payment split across a customer's invoices, oldest first", () => {
  const mk = (amount: number, date: number, op: string, over: Record<string, unknown> = {}) =>
    createInvoice({ ...base, customerId: "c1", items: [line({ quantity: 1, price: amount, lineTotal: amount })], status: "unpaid", createdBy: "user", actor: "user", operationId: op, ...over }).then(async (i) => {
      store.put(`invoices/${i.id}`, { ...store.read(`invoices/${i.id}`)!, date });
      return i;
    });
  const owed = async () => (await getCustomerDebt("c1")).balance;

  beforeEach(() => {
    store.put("customers/c1", { name: "Hoa Lee", aliases: [], active: true });
  });

  it("several invoices: oldest paid in full, next one partial, newest untouched; total owed drops by exactly the payment", async () => {
    const newest = await mk(50, 3000, "s3");
    const oldest = await mk(100, 1000, "s1");
    const middle = await mk(80, 2000, "s2");
    expect(await owed()).toBe(230);
    const r = await recordCustomerPayment({ customerId: "c1", amount: 150, method: "cash", actor: "user", operationId: "cp1" });
    expect(r.allocations.map((a) => [a.invoiceId, a.amount])).toEqual([[oldest.id, 100], [middle.id, 50]]);
    expect(store.read(`invoices/${oldest.id}`)).toMatchObject({ amountPaid: 100, balance: 0, paymentStatus: "paid" });
    expect(store.read(`invoices/${middle.id}`)).toMatchObject({ amountPaid: 50, balance: 30, paymentStatus: "partial" });
    expect(store.read(`invoices/${newest.id}`)).toMatchObject({ amountPaid: 0, balance: 50, paymentStatus: "unpaid" });
    expect(await owed()).toBe(80);
    expect(r.leftover).toBe(0);
    expect(store.read("customers/c1")).not.toHaveProperty("credit");
    // One payment row and one log per invoice touched, sharing one receipt id.
    const pays = store.list("payments").map(([, p]) => p);
    expect(pays.map((p) => [p.invoiceId, p.amount])).toEqual(expect.arrayContaining([[oldest.id, 100], [middle.id, 50]]));
    expect(pays).toHaveLength(2);
    expect(new Set(pays.map((p) => p.receiptId)).size).toBe(1);
    expect(store.list("invoiceLogs").filter(([, l]) => l.action === "payment")).toHaveLength(2);
  });

  it("exact pay: everything paid, no credit", async () => {
    await mk(100, 1000, "s1");
    await mk(80.25, 2000, "s2");
    const r = await recordCustomerPayment({ customerId: "c1", amount: 180.25, actor: "user" });
    expect(r.leftover).toBe(0);
    expect(await owed()).toBe(0);
    expect(store.list("invoices").every(([, i]) => i.paymentStatus === "paid")).toBe(true);
  });

  it("overpay: invoices paid, the extra is kept as customer credit with its own payment row", async () => {
    await mk(100, 1000, "s1");
    const r = await recordCustomerPayment({ customerId: "c1", amount: 130, actor: "user" });
    expect(r.leftover).toBe(30);
    expect(r.credit).toBe(30);
    expect(store.read("customers/c1")).toMatchObject({ credit: 30 });
    const extra = store.list("payments").map(([, p]) => p).find((p) => p.unallocated);
    expect(extra).toMatchObject({ invoiceId: "", customerId: "c1", amount: 30, unallocated: true });
    // A second overpay adds to the existing credit.
    await recordCustomerPayment({ customerId: "c1", amount: 5, actor: "user" });
    expect(store.read("customers/c1")).toMatchObject({ credit: 35 });
  });

  it("a $0 open delivery is skipped (stays unpaid at $0) and the money goes to the next invoice", async () => {
    const delivery = await mk(0, 500, "d0", { delivery: true, items: [line({ quantity: 3, price: 0, lineTotal: 0 })] });
    const real = await mk(60, 1000, "s1");
    const r = await recordCustomerPayment({ customerId: "c1", amount: 60, actor: "user" });
    expect(r.allocations.map((a) => a.invoiceId)).toEqual([real.id]);
    expect(store.read(`invoices/${delivery.id}`)).toMatchObject({ amountPaid: 0, balance: 0 });
    expect(store.read(`invoices/${real.id}`)).toMatchObject({ paymentStatus: "paid" });
  });

  it("drafts, voids, paid invoices and other customers' invoices are never touched", async () => {
    const draft = await mk(40, 100, "dr", { status: "draft" });
    const other = await mk(40, 100, "ot", { customerId: "c2" });
    const real = await mk(40, 1000, "s1");
    await recordCustomerPayment({ customerId: "c1", amount: 40, actor: "user" });
    expect(store.read(`invoices/${draft.id}`)).toMatchObject({ amountPaid: 0, paymentStatus: "draft" });
    expect(store.read(`invoices/${other.id}`)).toMatchObject({ amountPaid: 0, paymentStatus: "unpaid" });
    expect(store.read(`invoices/${real.id}`)).toMatchObject({ paymentStatus: "paid" });
  });

  it("does not touch stock (only already-committed invoices are paid)", async () => {
    store.put("products/p1", { name: "Milo", quantity: 50, active: true });
    await mk(29, 1000, "s1");
    const before = store.read("products/p1");
    await recordCustomerPayment({ customerId: "c1", amount: 29, actor: "user" });
    expect(store.read("products/p1")).toEqual(before);
  });

  it("replaying the same operationId applies the payment once; a reused key with a different amount is rejected", async () => {
    await mk(100, 1000, "s1");
    await recordCustomerPayment({ customerId: "c1", amount: 40, actor: "user", operationId: "cp-retry" });
    await recordCustomerPayment({ customerId: "c1", amount: 40, actor: "user", operationId: "cp-retry" });
    expect(await owed()).toBe(60);
    expect(store.count("payments")).toBe(1);
    await expect(recordCustomerPayment({ customerId: "c1", amount: 41, actor: "user", operationId: "cp-retry" })).rejects.toBeInstanceOf(OperationConflictError);
  });

  it("rejects a missing customer and a non-positive amount with no write", async () => {
    await mk(100, 1000, "s1");
    await expect(recordCustomerPayment({ customerId: "nope", amount: 10, actor: "user" })).rejects.toBeInstanceOf(NotFoundError);
    for (const bad of [0, -5, Number.NaN, Infinity]) {
      await expect(recordCustomerPayment({ customerId: "c1", amount: bad, actor: "user" })).rejects.toBeInstanceOf(ValidationError);
    }
    expect(store.count("payments")).toBe(0);
    expect(await owed()).toBe(100);
  });
});
