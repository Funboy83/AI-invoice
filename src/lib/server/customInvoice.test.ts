import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { NextRequest } from "next/server";
import { store, adminFacade } from "@/test/fakeFirestore";
import { __setAdminDbForTests } from "./firebaseAdmin";
import { createInvoice, getCustomerDebt, createCustomer, saveInvoicePrintInfo, getInvoicePrintInfo, getCustomInvoiceDefaults } from "./businessStore";
import { requireDateKey, requirePrintInfo } from "./businessValidation";
import type { AuthedUser } from "./auth";

const mockAuthenticate = vi.fn<(req: Request) => Promise<AuthedUser>>();
vi.mock("@/lib/server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/auth")>();
  return { ...actual, authenticate: (req: Request) => mockAuthenticate(req) };
});

beforeEach(() => {
  store.reset();
  __setAdminDbForTests(adminFacade() as unknown as Firestore);
  mockAuthenticate.mockReset();
  mockAuthenticate.mockResolvedValue({ uid: "u", email: "u@example.com", storeId: "main" });
});

const form = {
  template: "professional",
  from: { name: "N&E ENTERPRISE INC", address: "14902 Moran St", phone: "714", email: "a@b.c" },
  billTo: { address: "13872 West St", phone: "" },
  shipTo: { name: "Dock", address: "Dock 4", phone: "" },
  date: "2026-10-07",
  dueDate: "",
  deliveryDate: "2026-10-08",
  po: "PO-1",
  notes: "Deliver before noon",
  terms: "BANK NAME: EXAMPLE",
};

async function seed() {
  const customer = await createCustomer({ name: "TA FONG CORPORATION" });
  const invoice = await createInvoice({
    customerId: customer.id,
    customerName: customer.name,
    items: [{ productId: "p1", productName: "BRETEL BUTTER", quantity: 80, unit: "16.5 bs", price: 165, lineTotal: 13200 }],
    status: "unpaid",
    createdBy: "user",
    actor: "user",
  });
  return { customer, invoice };
}

function put(id: string, body: unknown) {
  return new NextRequest(`http://localhost/api/business/custom-invoices/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("Custom Invoice print info", () => {
  it("saves info for an invoice without touching the invoice, its number, or the customer's debt", async () => {
    const { customer, invoice } = await seed();
    const before = store.read(`invoices/${invoice.id}`);
    const counter = store.read("counters/invoiceCounter");
    const debt = await getCustomerDebt(customer.id);
    await saveInvoicePrintInfo({ invoiceId: invoice.id, ...requirePrintInfo(form) } as Parameters<typeof saveInvoicePrintInfo>[0]);
    expect(store.read(`invoices/${invoice.id}`)).toEqual(before);
    expect(store.read("counters/invoiceCounter")).toEqual(counter);
    expect(await getCustomerDebt(customer.id)).toEqual(debt);
    expect((await getInvoicePrintInfo(invoice.id))?.notes).toBe("Deliver before noon");
  });

  it("remembers the company block and terms as defaults for the next invoice", async () => {
    const { invoice } = await seed();
    expect((await getCustomInvoiceDefaults()).terms).toBe("");
    await saveInvoicePrintInfo({ invoiceId: invoice.id, ...requirePrintInfo({ ...form, from: { ...form.from, name: "NEW CO" } }) });
    const d = await getCustomInvoiceDefaults();
    expect([d.from.name, d.terms]).toEqual(["NEW CO", "BANK NAME: EXAMPLE"]);
  });

  it("PUT ignores items, prices, totals and customer name sent by the client", async () => {
    const { invoice } = await seed();
    const { PUT } = await import("@/app/api/business/custom-invoices/[invoiceId]/route");
    const res = await PUT(put(invoice.id, { ...form, items: [], total: 1, customerName: "Hacker", invoiceNumber: "1" }), { params: Promise.resolve({ invoiceId: invoice.id }) });
    expect(res.status).toBe(200);
    const saved = store.read(`invoicePrintInfo/${invoice.id}`)!;
    for (const k of ["items", "total", "customerName", "invoiceNumber"]) expect(saved).not.toHaveProperty(k);
    expect(store.read(`invoices/${invoice.id}`)!.total).toBe(13200);
  });

  it("PUT refuses an unknown invoice and a bad template or date, with no write", async () => {
    const { invoice } = await seed();
    const { PUT } = await import("@/app/api/business/custom-invoices/[invoiceId]/route");
    const call = (id: string, body: unknown) => PUT(put(id, body), { params: Promise.resolve({ invoiceId: id }) });
    expect((await call("nope", form)).status).toBe(404);
    expect((await call(invoice.id, { ...form, template: "fancy" })).status).toBe(400);
    expect((await call(invoice.id, { ...form, date: "2026-02-30" })).status).toBe(400);
    expect(store.count("invoicePrintInfo")).toBe(0);
  });
});

describe("requireDateKey", () => {
  it("accepts real dates only", () => {
    expect(requireDateKey("2026-10-07", "d")).toBe("2026-10-07");
    for (const bad of ["2026-2-1", "2026-13-01", "2026-02-30", "10/07/2026", 20261007, ""]) expect(() => requireDateKey(bad, "d")).toThrow();
  });
});
