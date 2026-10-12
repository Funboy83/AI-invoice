import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { NextRequest } from "next/server";
import { store, adminFacade } from "@/test/fakeFirestore";
import { __setAdminDbForTests } from "./firebaseAdmin";
import { createInvoice, createCustomInvoice, updateCustomInvoiceDate, getCustomerDebt, createCustomer, createProduct } from "./businessStore";
import { requireDateKey } from "./businessValidation";
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

async function seedInvoice(status: "unpaid" | "draft" | "void" = "unpaid") {
  const customer = await createCustomer({ name: "TA FONG CORPORATION", address: "13872 West St, Garden Grove CA 92843", phone: "714-000-0000", shippingAddress: "Dock 4" });
  const product = await createProduct({ name: "BRETEL BUTTER", defaultPrice: 165, defaultUnit: "16.5 bs/8.8202", barcode: "89013" });
  const invoice = await createInvoice({
    customerId: customer.id,
    customerName: customer.name,
    items: [{ productId: product.id, productName: product.name, quantity: 80, unit: "16.5 bs/8.8202", price: 165, lineTotal: 13200 }],
    discount: 0,
    status,
    createdBy: "user",
    actor: "user",
  });
  return { customer, invoice };
}

describe("createCustomInvoice", () => {
  it("takes the next number from the normal invoice counter and copies the invoice exactly", async () => {
    const { invoice } = await seedInvoice();
    expect(invoice.invoiceNumber).toBe("2000");
    const ci = await createCustomInvoice({ sourceInvoiceId: invoice.id, date: "2026-10-07", actor: "user" });
    expect(ci.invoiceNumber).toBe("2001");
    expect(ci.date).toBe("2026-10-07");
    expect(ci.sourceInvoiceNumber).toBe("2000");
    expect(ci.customerName).toBe("TA FONG CORPORATION");
    expect(ci.billToAddress).toBe("13872 West St, Garden Grove CA 92843");
    expect(ci.shipToAddress).toBe("Dock 4");
    expect(ci.items).toHaveLength(1);
    expect(ci.items[0]).toMatchObject({ quantity: 80, price: 165, lineTotal: 13200, barcode: "89013" });
    expect([ci.subtotal, ci.total]).toEqual([13200, 13200]);
    // The next real invoice continues the same sequence.
    const next = await createInvoice({ customerName: "X", items: invoice.items, status: "unpaid", createdBy: "user", actor: "user" });
    expect(next.invoiceNumber).toBe("2002");
  });

  it("never changes the customer's debt, the source invoice, or stock", async () => {
    const { customer, invoice } = await seedInvoice();
    const before = store.read(`invoices/${invoice.id}`);
    const debtBefore = await getCustomerDebt(customer.id);
    await createCustomInvoice({ sourceInvoiceId: invoice.id, date: "2026-10-07", actor: "user" });
    expect(store.read(`invoices/${invoice.id}`)).toEqual(before);
    expect(await getCustomerDebt(customer.id)).toEqual(debtBefore);
    expect(store.count("invoices")).toBe(1);
    expect(store.count("customInvoices")).toBe(1);
  });

  it("refuses drafts and voided invoices, without using up a number", async () => {
    for (const status of ["draft", "void"] as const) {
      store.reset();
      const { invoice } = await seedInvoice(status);
      await expect(createCustomInvoice({ sourceInvoiceId: invoice.id, date: "2026-10-07", actor: "user" })).rejects.toThrow();
      expect(store.read("counters/invoiceCounter")).toEqual({ value: 2000 });
      expect(store.count("customInvoices")).toBe(0);
    }
  });

  it("is idempotent per operationId: a retried save creates one copy and one number", async () => {
    const { invoice } = await seedInvoice();
    const a = await createCustomInvoice({ sourceInvoiceId: invoice.id, date: "2026-10-07", actor: "user", operationId: "op1" });
    const b = await createCustomInvoice({ sourceInvoiceId: invoice.id, date: "2026-10-07", actor: "user", operationId: "op1" });
    expect(b).toEqual(a);
    expect(store.count("customInvoices")).toBe(1);
    expect(store.read("counters/invoiceCounter")).toEqual({ value: 2001 });
  });
});

describe("updateCustomInvoiceDate", () => {
  it("changes only the date and logs before/after", async () => {
    const { invoice } = await seedInvoice();
    const ci = await createCustomInvoice({ sourceInvoiceId: invoice.id, date: "2026-10-07", actor: "user" });
    const updated = await updateCustomInvoiceDate({ id: ci.id, date: "2026-09-30", actor: "user" });
    expect(updated.date).toBe("2026-09-30");
    const stored = store.read(`customInvoices/${ci.id}`)!;
    expect(stored.date).toBe("2026-09-30");
    expect(stored.invoiceNumber).toBe(ci.invoiceNumber);
    expect(stored.total).toBe(ci.total);
    const logs = store.list("invoiceLogs").map(([, d]) => d).filter((d) => d.invoiceId === ci.id);
    expect(logs.map((l) => l.action).sort()).toEqual(["create", "update"]);
  });
});

describe("custom invoice routes", () => {
  function req(method: string, path: string, body?: unknown) {
    return new NextRequest(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }

  it("PATCH ignores everything except the date", async () => {
    const { invoice } = await seedInvoice();
    const ci = await createCustomInvoice({ sourceInvoiceId: invoice.id, date: "2026-10-07", actor: "user" });
    const { PATCH } = await import("@/app/api/business/custom-invoices/[id]/route");
    const res = await PATCH(req("PATCH", `/api/business/custom-invoices/${ci.id}`, { date: "2026-10-01", total: 1, customerName: "Hacker", invoiceNumber: "1" }), { params: Promise.resolve({ id: ci.id }) });
    expect(res.status).toBe(200);
    const stored = store.read(`customInvoices/${ci.id}`)!;
    expect([stored.date, stored.total, stored.customerName, stored.invoiceNumber]).toEqual(["2026-10-01", 13200, "TA FONG CORPORATION", ci.invoiceNumber]);
  });

  it("POST rejects a bad date with no write", async () => {
    const { invoice } = await seedInvoice();
    const { POST } = await import("@/app/api/business/custom-invoices/route");
    const res = await POST(req("POST", "/api/business/custom-invoices", { sourceInvoiceId: invoice.id, date: "2026-02-30" }));
    expect(res.status).toBe(400);
    expect(store.count("customInvoices")).toBe(0);
  });
});

describe("requireDateKey", () => {
  it("accepts real dates only", () => {
    expect(requireDateKey("2026-10-07", "d")).toBe("2026-10-07");
    for (const bad of ["2026-2-1", "2026-13-01", "2026-02-30", "10/07/2026", 20261007, ""]) expect(() => requireDateKey(bad, "d")).toThrow();
  });
});
