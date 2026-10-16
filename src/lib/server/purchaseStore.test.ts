import { beforeEach, describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { store, adminFacade } from "@/test/fakeFirestore";
import { __setAdminDbForTests } from "./firebaseAdmin";
import { createPurchase, createVendor, getPurchasesForVendor, recordVendorPayment, updatePurchaseInfo, voidPurchase } from "./purchaseStore";
import { DomainError, ValidationError } from "@/lib/domainErrors";

const product = (id: string, data: Record<string, unknown>) =>
  store.put(`products/${id}`, { name: id, aliases: [], defaultUnit: "thùng", defaultPrice: 30, active: true, createdAt: 1, updatedAt: 1, ...data });

let vendorId = "";
beforeEach(async () => {
  store.reset();
  __setAdminDbForTests(adminFacade() as unknown as Firestore);
  product("milo", { quantity: 5, cost: 20 });
  product("tea", { quantity: null, cost: null });
  vendorId = (await createVendor({ name: "Costco" })).id;
});

const base = () => ({ vendorId, dateKey: "2026-10-15", items: [{ productId: "milo", quantity: 10, cost: 21.5 }], updateCost: true });

describe("createPurchase", () => {
  it("computes totals on the server, adds stock, updates cost, and numbers purchases PO-1001, PO-1002", async () => {
    const { purchase } = await createPurchase({ ...base(), items: [{ productId: "milo", quantity: 10, cost: 21.5 }, { productId: "tea", quantity: 3, cost: 4.1 }], shipping: 5, discount: 1, vendorInvoiceNumber: "INV-1" });
    expect(purchase.purchaseNumber).toBe("PO-1001");
    expect(purchase.subtotal).toBe(227.3);
    expect(purchase.total).toBe(231.3);
    expect(purchase.balance).toBe(231.3);
    expect(purchase.paymentStatus).toBe("unpaid");
    expect(store.read("products/milo")).toMatchObject({ quantity: 15, cost: 21.5 });
    // Untracked product starts being counted at the bought quantity.
    expect(store.read("products/tea")).toMatchObject({ quantity: 3, cost: 4.1 });
    const second = await createPurchase({ ...base(), vendorInvoiceNumber: "INV-2" });
    expect(second.purchase.purchaseNumber).toBe("PO-1002");
  });

  it("leaves cost alone when asked not to update it", async () => {
    await createPurchase({ ...base(), updateCost: false });
    expect(store.read("products/milo")).toMatchObject({ quantity: 15, cost: 20 });
  });

  it("is idempotent: retrying the same Save adds stock once and creates one purchase", async () => {
    const a = await createPurchase({ ...base(), operationId: "op-purchase-1" });
    const b = await createPurchase({ ...base(), operationId: "op-purchase-1" });
    expect(b.purchase.id).toBe(a.purchase.id);
    expect(store.count("purchases")).toBe(1);
    expect(store.read("products/milo")).toMatchObject({ quantity: 15 });
  });

  it("records a payment made right away and refuses paying more than the total", async () => {
    const { purchase } = await createPurchase({ ...base(), paidNow: 100, payMethod: "cash" });
    expect(purchase).toMatchObject({ amountPaid: 100, balance: 115, paymentStatus: "partial" });
    expect(store.count("vendorPayments")).toBe(1);
    await expect(createPurchase({ ...base(), paidNow: 216, vendorInvoiceNumber: "X" })).rejects.toBeInstanceOf(ValidationError);
  });

  it("refuses the same vendor invoice number twice for one vendor, ignoring case and spaces, with no stock change", async () => {
    await createPurchase({ ...base(), vendorInvoiceNumber: "INV 77" });
    await expect(createPurchase({ ...base(), vendorInvoiceNumber: "inv77" })).rejects.toBeInstanceOf(DomainError);
    expect(store.read("products/milo")).toMatchObject({ quantity: 15 });
    expect(store.count("purchases")).toBe(1);
  });

  it("rejects zero/negative quantity and a missing product with no write", async () => {
    await expect(createPurchase({ ...base(), items: [{ productId: "milo", quantity: 0, cost: 1 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(createPurchase({ ...base(), items: [{ productId: "ghost", quantity: 1, cost: 1 }] })).rejects.toBeInstanceOf(DomainError);
    expect(store.count("purchases")).toBe(0);
    expect(store.read("products/milo")).toMatchObject({ quantity: 5 });
  });
});

describe("paying vendors", () => {
  it("moves unpaid → partial → paid and refuses overpaying", async () => {
    const { purchase } = await createPurchase(base());
    expect((await recordVendorPayment({ purchaseId: purchase.id, amount: 100 })).paymentStatus).toBe("partial");
    await expect(recordVendorPayment({ purchaseId: purchase.id, amount: 200 })).rejects.toBeInstanceOf(ValidationError);
    const paid = await recordVendorPayment({ purchaseId: purchase.id, amount: 115, operationId: "op-pay-1" });
    expect(paid).toMatchObject({ amountPaid: 215, balance: 0, paymentStatus: "paid" });
    // A retried payment is not recorded twice.
    await recordVendorPayment({ purchaseId: purchase.id, amount: 115, operationId: "op-pay-1" });
    expect(store.count("vendorPayments")).toBe(2);
  });
});

describe("voidPurchase", () => {
  it("takes the stock back out, voids its payments and stops it counting as owed", async () => {
    const { purchase } = await createPurchase({ ...base(), paidNow: 50 });
    const { purchase: v, stockWarnings } = await voidPurchase(purchase.id);
    expect(v.paymentStatus).toBe("void");
    expect(stockWarnings).toEqual([]);
    expect(store.read("products/milo")).toMatchObject({ quantity: 5 });
    expect(store.list("vendorPayments")[0][1]).toMatchObject({ voided: true });
    await expect(voidPurchase(purchase.id)).rejects.toBeInstanceOf(DomainError);
    await expect(recordVendorPayment({ purchaseId: purchase.id, amount: 1 })).rejects.toBeInstanceOf(DomainError);
    // Its vendor invoice number can be used again after cancelling.
    await createPurchase({ ...base() });
    expect((await getPurchasesForVendor(vendorId)).length).toBe(2);
  });

  it("warns when stock goes below zero because some was already sold", async () => {
    const { purchase } = await createPurchase(base());
    store.put("products/milo", { ...store.read("products/milo")!, quantity: 3 });
    const { stockWarnings } = await voidPurchase(purchase.id);
    expect(store.read("products/milo")).toMatchObject({ quantity: -7 });
    expect(stockWarnings[0]).toContain("below zero");
  });
});

describe("updatePurchaseInfo", () => {
  it("changes look-up details only, and still blocks a duplicate vendor invoice number", async () => {
    const a = await createPurchase({ ...base(), vendorInvoiceNumber: "A1" });
    const b = await createPurchase({ ...base(), vendorInvoiceNumber: "B1" });
    const updated = await updatePurchaseInfo(b.purchase.id, { vendorInvoiceNumber: "B2", notes: "box damaged" });
    expect(updated).toMatchObject({ vendorInvoiceNumber: "B2", notes: "box damaged", total: b.purchase.total });
    await expect(updatePurchaseInfo(b.purchase.id, { vendorInvoiceNumber: "a1" })).rejects.toBeInstanceOf(DomainError);
    // Keeping its own number is fine.
    await updatePurchaseInfo(a.purchase.id, { vendorInvoiceNumber: "A1" });
    expect(store.read("products/milo")).toMatchObject({ quantity: 25 });
  });
});
