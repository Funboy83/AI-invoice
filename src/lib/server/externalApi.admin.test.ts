import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";

vi.mock("firebase/firestore", async () => (await import("@/test/fakeFirestore")).clientModule);
vi.mock("@/lib/firebase", () => ({ db: {}, firebaseApp: {} }));

import { store, adminFacade } from "@/test/fakeFirestore";
import { __setAdminDbForTests } from "@/lib/server/firebaseAdmin";
import type { AuthedUser } from "./auth";
import { runExternalTool } from "./externalApi";

/** The "admin" half of the outside-AI door: everything the app's pages can do, each write previewed then confirmed. */

const wife: AuthedUser = { uid: "wife", email: "wife@example.com", storeId: "main" };
type R = Record<string, unknown> & { status: string; confirmToken?: string; preview?: Record<string, unknown> };
const run = (name: string, args: Record<string, unknown>) => runExternalTool(name, args, wife) as Promise<R>;
/** Preview, check nothing was written, then confirm. */
async function previewThenConfirm(name: string, args: Record<string, unknown>, collection: string) {
  const before = store.count(collection);
  const preview = await run(name, args);
  expect(preview.status, JSON.stringify(preview)).toBe("needs_confirmation");
  expect(store.count(collection)).toBe(before);
  const saved = await run("confirmAction", { confirmToken: preview.confirmToken });
  return { preview, saved };
}
const read = (path: string) => store.docs.get(path) as Record<string, unknown>;
const purchases = () => [...store.docs.keys()].filter((k) => k.startsWith("purchases/"));

beforeEach(() => {
  store.reset();
  __setAdminDbForTests(adminFacade() as unknown as Firestore);
  store.put("storeMembers/wife", { uid: "wife", email: "wife@example.com", storeId: "main", addedAt: 1, addedByEmail: "a@x.com" });
  store.put("customers/c1", { name: "Hoa Lee", aliases: [], active: true, defaultShipping: 0, createdAt: 1, updatedAt: 1 });
  store.put("products/p1", { name: "Milo", aliases: [], defaultUnit: "thùng", defaultPrice: 29, cost: 20, quantity: 100, active: true, createdAt: 1, updatedAt: 1 });
  for (let i = 1; i <= 25; i++) store.put(`products/g${i}`, { name: `Hàng số ${i}`, aliases: [], defaultUnit: "thùng", defaultPrice: 10, quantity: null, active: true, createdAt: 1, updatedAt: 1 });
});

describe("Buy from vendor", () => {
  it("adds vendor Ngan, then a 25-line purchase in one call: stock and costs change only after confirm", async () => {
    const { saved: v } = await previewThenConfirm("createVendor", { name: "Ngan", phone: "714-000" }, "vendors");
    expect(v.status).toBe("created");
    const vendorId = (v.vendor as { id: string }).id;

    const items = Array.from({ length: 25 }, (_, i) => ({ productName: `hang so ${i + 1}`, quantity: 2, cost: 3.5 }));
    const { preview, saved } = await previewThenConfirm("createPurchase", { vendorName: "ngan", vendorInvoiceNumber: "NG-77", date: "2026-10-16", items, paidNow: 50 }, "purchases");
    expect(preview.preview).toMatchObject({ vendor: { id: vendorId, name: "Ngan" }, subtotal: 175, total: 175, paidNow: 50, stillOwedAfter: 125 });
    expect((preview.preview!.items as unknown[]).length).toBe(25);
    expect(saved.status).toBe("created");
    expect(saved.purchase).toMatchObject({ purchaseNumber: "PO-1001", total: 175, amountPaid: 50, balance: 125, status: "partial" });
    expect(read("products/g7")).toMatchObject({ quantity: 2, cost: 3.5 });
    // A second confirm of the same token never adds stock twice.
    await run("confirmAction", { confirmToken: preview.confirmToken });
    expect(purchases()).toHaveLength(1);
    expect(read("products/g7")).toMatchObject({ quantity: 2 });

    const list = (await run("listVendors", {})) as unknown as { vendors: { name: string; owed: number }[] };
    expect(list.vendors).toContainEqual(expect.objectContaining({ name: "Ngan", owed: 125 }));
    const found = (await run("searchPurchases", { query: "ng 77" })) as unknown as { purchases: { purchaseNumber: string }[] };
    expect(found.purchases.map((p) => p.purchaseNumber)).toEqual(["PO-1001"]);
  });

  it("refuses a duplicate vendor invoice # and paying more than the total, before any token", async () => {
    store.put("vendors/v1", { name: "Costco", active: true, createdAt: 1, updatedAt: 1 });
    await previewThenConfirm("createPurchase", { vendorId: "v1", vendorInvoiceNumber: "INV 1", items: [{ productId: "p1", quantity: 1, cost: 20 }] }, "purchases");
    const dup = await run("createPurchase", { vendorId: "v1", vendorInvoiceNumber: "inv1", items: [{ productId: "p1", quantity: 1, cost: 20 }] });
    expect(dup).toMatchObject({ status: "error" });
    expect(String(dup.message)).toMatch(/already saved as PO-1001/);
    const over = await run("createPurchase", { vendorId: "v1", vendorInvoiceNumber: "X", items: [{ productId: "p1", quantity: 1, cost: 20 }], paidNow: 21 });
    expect(over.status).toBe("error");
    const pending = store.count("apiPendingActions");
    expect(await run("createPurchase", { vendorName: "nobody", items: [{ productId: "p1", quantity: 1, cost: 1 }] })).toMatchObject({ status: "needs_new_vendor" });
    expect(await run("createPurchase", { vendorId: "v1", items: [{ productName: "no such thing", quantity: 1, cost: 1 }] })).toMatchObject({ status: "needs_new_product" });
    expect(store.count("apiPendingActions")).toBe(pending);
  });

  it("uses the product's saved cost when none is given, keeps costs when updateCost=false, and pays in full", async () => {
    store.put("vendors/v1", { name: "Costco", active: true, createdAt: 1, updatedAt: 1 });
    const { preview, saved } = await previewThenConfirm("createPurchase", { vendorId: "v1", items: [{ productId: "p1", quantity: 10 }], updateCost: false, payInFull: true }, "purchases");
    expect(preview.preview).toMatchObject({ total: 200, paidNow: 200, stock: [{ productName: "Milo", stockNow: 100, stockAfter: 110 }] });
    expect(saved.purchase).toMatchObject({ status: "paid", balance: 0 });
    expect(read("products/p1")).toMatchObject({ quantity: 110, cost: 20 });
  });

  it("records a vendor payment (never more than owed) and cancels a purchase, taking the stock back", async () => {
    store.put("vendors/v1", { name: "Costco", active: true, createdAt: 1, updatedAt: 1 });
    await previewThenConfirm("createPurchase", { vendorId: "v1", vendorInvoiceNumber: "A1", items: [{ productId: "p1", quantity: 5, cost: 10 }] }, "purchases");
    expect((await run("recordVendorPayment", { purchaseNumber: "PO-1001", amount: 51 })).status).toBe("error");
    const { saved: paid } = await previewThenConfirm("recordVendorPayment", { purchaseNumber: "1001", amount: 20, method: "zelle" }, "vendorPayments");
    expect(paid.purchase).toMatchObject({ amountPaid: 20, balance: 30, status: "partial" });

    const { preview, saved } = await previewThenConfirm("cancelPurchase", { purchaseNumber: "PO-1001" }, "purchases");
    expect(preview.preview).toMatchObject({ stockTakenBack: [{ productName: "Milo", takeOut: 5, stockNow: 105, stockAfter: 100 }], owedToVendorDropsBy: 30 });
    expect(saved.status).toBe("cancelled");
    expect(read("products/p1")).toMatchObject({ quantity: 100 });
    expect((await run("cancelPurchase", { purchaseNumber: "PO-1001" })).status).toBe("error");
  });

  it("fixes a purchase's vendor invoice # and date, nothing else", async () => {
    store.put("vendors/v1", { name: "Costco", active: true, createdAt: 1, updatedAt: 1 });
    const { saved: p } = await previewThenConfirm("createPurchase", { vendorId: "v1", vendorInvoiceNumber: "A1", date: "2026-10-01", items: [{ productId: "p1", quantity: 1, cost: 10 }] }, "purchases");
    const id = (p.purchase as { id: string }).id;
    const { saved } = await previewThenConfirm("updatePurchaseInfo", { purchaseId: id, vendorInvoiceNumber: "A2", date: "2026-10-02" }, "purchases");
    expect(saved.status).toBe("updated");
    expect(read(`purchases/${id}`)).toMatchObject({ vendorInvoiceNumber: "A2", dateKey: "2026-10-02", total: 10 });
  });
});

describe("selling side", () => {
  const invoice = (id: string, data: Record<string, unknown>) =>
    store.put(`invoices/${id}`, {
      invoiceNumber: id.toUpperCase(), customerId: "c1", customerName: "Hoa Lee", date: Date.parse("2026-10-10T20:00:00Z"), createdAt: 1, updatedAt: 1,
      items: [{ productId: "p1", productName: "Milo", quantity: 2, unit: "thùng", price: 29, lineTotal: 58 }],
      shipping: 0, discount: 0, subtotal: 58, total: 58, amountPaid: 0, balance: 58, paymentStatus: "unpaid", deductedQuantities: [], ...data,
    });

  it("records a customer payment but never more than the invoice still owes", async () => {
    invoice("i1", {});
    expect((await run("recordPayment", { invoiceId: "i1", amount: 60 })).status).toBe("error");
    const { preview, saved } = await previewThenConfirm("recordPayment", { invoiceId: "i1", amount: 20, method: "cash" }, "payments");
    expect(preview.preview).toMatchObject({ before: { balance: 58 }, after: { balance: 38, status: "partial" } });
    expect(saved.status).toBe("recorded");
    expect(read("invoices/i1")).toMatchObject({ amountPaid: 20, balance: 38, paymentStatus: "partial" });
  });

  it("records one customer payment oldest invoice first, never more than owed; fixes and cancels it; adjusts debt with a reason", async () => {
    invoice("i1", { date: Date.parse("2026-10-01T20:00:00Z") });
    invoice("i2", { date: Date.parse("2026-10-05T20:00:00Z") });
    expect((await run("recordCustomerPayment", { customerName: "hoa lee", amount: 200 })).status).toBe("error");
    const { preview, saved } = await previewThenConfirm("recordCustomerPayment", { customerName: "hoa lee", amount: 70, method: "Zelle" }, "payments");
    expect(preview.preview).toMatchObject({ debtBefore: 116, debtAfter: 46 });
    expect((preview.preview!.invoices as { invoiceNumber: string; applied: number }[]).map((i) => [i.invoiceNumber, i.applied])).toEqual([["I1", 58], ["I2", 12]]);
    expect(saved.status).toBe("recorded");
    expect(read("invoices/i1")).toMatchObject({ amountPaid: 58, paymentStatus: "paid" });
    expect(read("invoices/i2")).toMatchObject({ amountPaid: 12, balance: 46, paymentStatus: "partial" });

    const i2Payment = [...store.docs.entries()].find(([k, v]) => k.startsWith("payments/") && (v as { invoiceId: string }).invoiceId === "i2")![0].split("/")[1];
    expect((await run("changePayment", { paymentId: i2Payment, action: "edit", amount: 10 })).status).toBe("error"); // no reason
    const fix = await previewThenConfirm("changePayment", { paymentId: i2Payment, action: "edit", amount: 10, reason: "typed 12" }, "payments");
    expect(fix.preview.preview).toMatchObject({ before: { balance: 46 }, after: { balance: 48, status: "partial" } });
    expect(fix.saved.status).toBe("updated");
    expect(read("invoices/i2")).toMatchObject({ amountPaid: 10, balance: 48 });
    const cancel = await previewThenConfirm("changePayment", { paymentId: i2Payment, action: "cancel", reason: "check bounced" }, "payments");
    expect(cancel.saved.status).toBe("cancelled");
    expect(read("invoices/i2")).toMatchObject({ amountPaid: 0, paymentStatus: "unpaid" });
    expect(read(`payments/${i2Payment}`)).toMatchObject({ cancelled: true });

    expect((await run("adjustCustomerDebt", { customerId: "c1", amount: 1 })).status).toBe("error"); // no reason
    const adj = await previewThenConfirm("adjustCustomerDebt", { customerId: "c1", amount: 8, reason: "damaged box" }, "payments");
    expect(adj.saved.status).toBe("recorded");
    expect(read("invoices/i2")).toMatchObject({ amountPaid: 8, balance: 50 });
  });

  it("adds an item, voids an invoice, and sets a delivery's final prices — each after confirm", async () => {
    invoice("i1", {});
    const { preview } = await previewThenConfirm("addInvoiceItem", { invoiceId: "i1", productName: "milo", quantity: 1, reason: "thêm" }, "invoices");
    expect(preview.preview).toMatchObject({ before: { total: 58 }, after: { total: 87 } });
    expect(read("invoices/i1")).toMatchObject({ total: 87 });

    const { preview: v } = await previewThenConfirm("updateInvoice", { invoiceId: "i1", status: "void", reason: "sai đơn" }, "invoices");
    expect(v.preview).toMatchObject({ action: "Void (cancel) an invoice", after: { status: "void" } });
    expect(read("invoices/i1")).toMatchObject({ paymentStatus: "void" });

    invoice("d1", { items: [{ productId: "p1", productName: "Milo", quantity: 3, unit: "thùng", price: 0, lineTotal: 0 }], subtotal: 0, total: 0, balance: 0, delivery: { status: "open" } });
    expect((await run("convertDelivery", { invoiceId: "d1", prices: [], reason: "x" })).status).toBe("error");
    const { saved } = await previewThenConfirm("convertDelivery", { invoiceId: "d1", prices: [{ productName: "milo", price: 30 }], reason: "chốt giá" }, "invoices");
    expect(saved.status).toBe("converted");
    expect(read("invoices/d1")).toMatchObject({ total: 90, balance: 90, delivery: { status: "converted" } });
  });

  it("can save a finished invoice in one step, and creates and edits customers", async () => {
    const { preview, saved } = await previewThenConfirm("createInvoiceDraft", { customerId: "c1", items: [{ productId: "p1", quantity: 1, price: 30 }], finalize: true }, "invoices");
    expect(preview.preview).toMatchObject({ total: 30 });
    expect((saved.invoice as { paymentStatus: string }).paymentStatus).toBe("unpaid");

    const { saved: c } = await previewThenConfirm("createCustomer", { name: "Cô Lan", phone: "555" }, "customers");
    expect(c.status).toBe("created");
    const id = (c.customer as { id: string }).id;
    await previewThenConfirm("updateCustomer", { customerId: id, address: "12 Bolsa" }, "customers");
    expect(read(`customers/${id}`)).toMatchObject({ address: "12 Bolsa" });
  });

  it("gives the payment request statement, the invoice list by day, and saves Custom Invoice info", async () => {
    invoice("i1", {});
    invoice("i2", { paymentStatus: "paid", amountPaid: 58, balance: 0, date: Date.parse("2026-10-12T20:00:00Z") });
    const st = (await run("getPaymentRequest", { customerId: "c1" })) as unknown as { totals: { count: number; totalOwed: number } };
    expect(st.totals).toMatchObject({ count: 1, totalOwed: 58 });
    const day = (await run("listInvoices", { dateFrom: "2026-10-10", dateTo: "2026-10-10" })) as unknown as { count: number; totalAmount: number };
    expect(day).toMatchObject({ count: 1, totalAmount: 58 });

    const { saved } = await previewThenConfirm("saveCustomInvoice", { invoiceId: "i1", po: "PO-9", template: "simple" }, "invoicePrintInfo");
    expect(saved.status).toBe("saved");
    expect((saved.info as { po: string; template: string })).toMatchObject({ po: "PO-9", template: "simple" });
    expect(read("invoices/i1")).toMatchObject({ total: 58 });
  });
});
