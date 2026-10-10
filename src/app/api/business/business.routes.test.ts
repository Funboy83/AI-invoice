import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { NextRequest } from "next/server";
import { store, adminFacade } from "@/test/fakeFirestore";
import { __setAdminDbForTests } from "@/lib/server/firebaseAdmin";
import { HttpError, type AuthedUser } from "@/lib/server/auth";
import { createInvoice } from "@/lib/server/businessStore";

/**
 * Route-handler tests for every src/app/api/business/** endpoint: authorization is delegated to authenticate()
 * (already covered by membership.test.ts and, end to end, by the emulator suite), so it's mocked here to isolate
 * what these routes are actually responsible for — server-side input validation, calling businessStore with a
 * server-controlled actor, and failing with NO partial write on bad input or a rejected identity.
 */
const mockAuthenticate = vi.fn<(req: Request) => Promise<AuthedUser>>();
vi.mock("@/lib/server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/auth")>();
  return { ...actual, authenticate: (req: Request) => mockAuthenticate(req) };
});

const MEMBER: AuthedUser = { uid: "wife", email: "wife@example.com", storeId: "main" };

function post(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
function patch(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  store.reset();
  __setAdminDbForTests(adminFacade() as unknown as Firestore);
  mockAuthenticate.mockReset();
  mockAuthenticate.mockResolvedValue(MEMBER);
});

describe("every business route rejects an unauthenticated or non-member caller, with no write at all", () => {
  const cases: [string, () => Promise<Response>][] = [
    ["POST /products", async () => (await import("./products/route")).POST(post("/api/business/products", { name: "Milo", defaultPrice: 10 }))],
    ["POST /customers", async () => (await import("./customers/route")).POST(post("/api/business/customers", { name: "Hoa Lee" }))],
    ["POST /invoices", async () => (await import("./invoices/route")).POST(post("/api/business/invoices", { customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: 1, price: 10 }] }))],
  ];

  for (const [label, call] of cases) {
    it(`${label}: 401 with no token`, async () => {
      mockAuthenticate.mockRejectedValue(new HttpError(401, "no token"));
      const res = await call();
      expect(res.status).toBe(401);
      expect(store.docs.size).toBe(0);
    });
    it(`${label}: 403 for a signed-in non-member`, async () => {
      mockAuthenticate.mockRejectedValue(new HttpError(403, "not a member"));
      const res = await call();
      expect(res.status).toBe(403);
      expect(store.docs.size).toBe(0);
    });
  }
});

describe("identity always comes from authenticate(), never from the request body", () => {
  it("a forged uid/storeId/ownerUid in the body has no effect at all — the route never reads them", async () => {
    const { POST } = await import("./products/route");
    const res = await POST(
      post("/api/business/products", {
        name: "Milo",
        defaultPrice: 29,
        // an attempted forgery: none of this is a real field these routes accept, and none of it is read
        uid: "someone-else",
        storeId: "a-different-store",
        ownerUid: "someone-else",
      })
    );
    expect(res.status).toBe(201);
    expect(mockAuthenticate).toHaveBeenCalledTimes(1); // authorization came from the token, once, not from the body
    expect(store.count("products")).toBe(1);
  });
});

describe("POST /api/business/products", () => {
  it("creates a product for a valid request, with no client control over anything but the fields it sends", async () => {
    const { POST } = await import("./products/route");
    const res = await POST(post("/api/business/products", { name: "Milo", defaultPrice: 29, aliases: ["milô"] }));
    expect(res.status).toBe(201);
    const { product } = await res.json();
    expect(product).toMatchObject({ name: "Milo", defaultPrice: 29, active: true });
    expect(store.count("products")).toBe(1);
  });

  it("rejects a negative or non-finite price, writing nothing", async () => {
    const { POST } = await import("./products/route");
    for (const bad of [-1, NaN, Infinity, "29"]) {
      const res = await POST(post("/api/business/products", { name: "Milo", defaultPrice: bad }));
      expect(res.status).toBe(400);
    }
    expect(store.count("products")).toBe(0);
  });

  it("rejects a missing/empty name, writing nothing", async () => {
    const { POST } = await import("./products/route");
    const res = await POST(post("/api/business/products", { defaultPrice: 10 }));
    expect(res.status).toBe(400);
    expect(store.count("products")).toBe(0);
  });

  it("an operationId makes a repeated request idempotent (double-click / retry safe)", async () => {
    const { POST } = await import("./products/route");
    const body = { name: "Milo", defaultPrice: 29, operationId: "click-attempt-1" };
    const a = await POST(post("/api/business/products", body));
    const b = await POST(post("/api/business/products", body));
    expect((await a.json()).product.id).toBe((await b.json()).product.id);
    expect(store.count("products")).toBe(1);
  });
});

describe("PATCH /api/business/products/[id]", () => {
  it("updates only the fields sent, validates price when present", async () => {
    const { POST } = await import("./products/route");
    const created = await (await POST(post("/api/business/products", { name: "Milo", defaultPrice: 29 }))).json();
    const { PATCH } = await import("./products/[id]/route");
    const ok = await PATCH(patch(`/api/business/products/${created.product.id}`, { defaultPrice: 31 }), { params: Promise.resolve({ id: created.product.id }) });
    expect(ok.status).toBe(200);
    expect(store.read(`products/${created.product.id}`)).toMatchObject({ defaultPrice: 31, name: "Milo" });

    const bad = await PATCH(patch(`/api/business/products/${created.product.id}`, { defaultPrice: -5 }), { params: Promise.resolve({ id: created.product.id }) });
    expect(bad.status).toBe(400);
    expect(store.read(`products/${created.product.id}`)).toMatchObject({ defaultPrice: 31 }); // unchanged
  });

  it("404s for an unknown product id", async () => {
    const { PATCH } = await import("./products/[id]/route");
    const res = await PATCH(patch("/api/business/products/nope", { defaultPrice: 5 }), { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/business/customers", () => {
  it("creates a customer; rejects an empty name with no write", async () => {
    const { POST } = await import("./customers/route");
    const ok = await POST(post("/api/business/customers", { name: "Hoa Lee", phone: "555" }));
    expect(ok.status).toBe(201);
    expect(store.count("customers")).toBe(1);
    const bad = await POST(post("/api/business/customers", { name: "" }));
    expect(bad.status).toBe(400);
    expect(store.count("customers")).toBe(1); // still just the one
  });
});

describe("POST /api/business/invoices (manual create)", () => {
  it("creates an invoice, always unpaid/user-created regardless of any status/actor/createdBy sent", async () => {
    const { POST } = await import("./invoices/route");
    const res = await POST(
      post("/api/business/invoices", {
        customerName: "Hoa Lee",
        items: [{ productName: "Milo", quantity: 2, price: 10 }],
        // attempted forgery: none of these should reach the store
        status: "paid",
        createdBy: "ai",
        actor: "ai",
      })
    );
    expect(res.status).toBe(201);
    const { invoice } = await res.json();
    expect(invoice).toMatchObject({ paymentStatus: "unpaid", createdBy: "user", total: 20 });
    const log = store.list("invoiceLogs")[0][1];
    expect(log.actor).toBe("user");
  });

  it("rejects a zero or negative quantity on a NEW invoice, with no write", async () => {
    const { POST } = await import("./invoices/route");
    for (const q of [0, -1]) {
      const res = await POST(post("/api/business/invoices", { customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: q, price: 10 }] }));
      expect(res.status).toBe(400);
    }
    expect(store.count("invoices")).toBe(0);
  });

  it("rejects a negative price, and ignores a forged lineTotal (recomputes from quantity*price)", async () => {
    const { POST } = await import("./invoices/route");
    const badPrice = await POST(post("/api/business/invoices", { customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: 1, price: -5 }] }));
    expect(badPrice.status).toBe(400);
    const forged = await POST(post("/api/business/invoices", { customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: 2, price: 10, lineTotal: 99999 }] }));
    expect((await forged.json()).invoice.items[0].lineTotal).toBe(20);
  });

  it("rejects an empty items array and a missing customer name, with no write", async () => {
    const { POST } = await import("./invoices/route");
    expect((await POST(post("/api/business/invoices", { customerName: "Hoa Lee", items: [] }))).status).toBe(400);
    expect((await POST(post("/api/business/invoices", { items: [{ productName: "Milo", quantity: 1, price: 1 }] }))).status).toBe(400);
    expect(store.count("invoices")).toBe(0);
  });
});

describe("PATCH /api/business/invoices/[id] (manual edit)", () => {
  async function seedInvoice() {
    return createInvoice({
      customerName: "Hoa Lee",
      items: [{ productId: "p1", productName: "Milo", quantity: 2, unit: "thùng", price: 10, lineTotal: 20 }],
      status: "unpaid",
      createdBy: "user",
      actor: "user",
      operationId: "seed",
    });
  }

  it("requires a non-empty reason; rejects with no write when missing", async () => {
    const inv = await seedInvoice();
    const { PATCH } = await import("./invoices/[id]/route");
    const res = await PATCH(patch(`/api/business/invoices/${inv.id}`, { shipping: 5 }), { params: Promise.resolve({ id: inv.id }) });
    expect(res.status).toBe(400);
    expect(store.read(`invoices/${inv.id}`)).toMatchObject({ shipping: 0 });
  });

  it("allows quantity 0 on an EDIT (finishing an incomplete draft one item at a time) but never negative", async () => {
    const inv = await seedInvoice();
    const { PATCH } = await import("./invoices/[id]/route");
    const zero = await PATCH(
      patch(`/api/business/invoices/${inv.id}`, { items: [{ productId: "p1", productName: "Milo", quantity: 0, price: 10 }], reason: "still missing qty" }),
      { params: Promise.resolve({ id: inv.id }) }
    );
    expect(zero.status).toBe(200);
    const negative = await PATCH(
      patch(`/api/business/invoices/${inv.id}`, { items: [{ productId: "p1", productName: "Milo", quantity: -1, price: 10 }], reason: "x" }),
      { params: Promise.resolve({ id: inv.id }) }
    );
    expect(negative.status).toBe(400);
  });

  it("rejects an edit line with no productId (matches the existing client-side rule, now enforced server-side)", async () => {
    const inv = await seedInvoice();
    const { PATCH } = await import("./invoices/[id]/route");
    const res = await PATCH(
      patch(`/api/business/invoices/${inv.id}`, { items: [{ productName: "Milo", quantity: 1, price: 10 }], reason: "x" }),
      { params: Promise.resolve({ id: inv.id }) }
    );
    expect(res.status).toBe(400);
  });

  it("rejects an unknown status value", async () => {
    const inv = await seedInvoice();
    const { PATCH } = await import("./invoices/[id]/route");
    const res = await PATCH(patch(`/api/business/invoices/${inv.id}`, { status: "shipped", reason: "x" }), { params: Promise.resolve({ id: inv.id }) });
    expect(res.status).toBe(400);
  });

  it("actor is always 'user', never read from the request body", async () => {
    const inv = await seedInvoice();
    const { PATCH } = await import("./invoices/[id]/route");
    await PATCH(patch(`/api/business/invoices/${inv.id}`, { notes: "hi", reason: "x", actor: "ai" }), { params: Promise.resolve({ id: inv.id }) });
    const logs = store.list("invoiceLogs").map(([, l]) => l);
    expect(logs.every((l) => l.actor === "user")).toBe(true);
  });

  it("404s for an unknown invoice id, with no write", async () => {
    const { PATCH } = await import("./invoices/[id]/route");
    const res = await PATCH(patch("/api/business/invoices/nope", { reason: "x", notes: "y" }), { params: Promise.resolve({ id: "nope" }) });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/business/invoices/[id]/payments", () => {
  it("records a positive payment; rejects zero/negative with no write", async () => {
    const inv = await createInvoice({ customerName: "Hoa Lee", items: [{ productId: "p1", productName: "Milo", quantity: 1, unit: "u", price: 100, lineTotal: 100 }], status: "unpaid", createdBy: "user", actor: "user", operationId: "seed2" });
    const { POST } = await import("./invoices/[id]/payments/route");
    for (const bad of [0, -5]) {
      const res = await POST(post(`/api/business/invoices/${inv.id}/payments`, { amount: bad }), { params: Promise.resolve({ id: inv.id }) });
      expect(res.status).toBe(400);
    }
    expect(store.count("payments")).toBe(0);
    const ok = await POST(post(`/api/business/invoices/${inv.id}/payments`, { amount: 40, method: "cash" }), { params: Promise.resolve({ id: inv.id }) });
    expect(ok.status).toBe(201);
    expect(store.read(`invoices/${inv.id}`)).toMatchObject({ amountPaid: 40, balance: 60, paymentStatus: "partial" });
  });

  it("a repeated operationId does not double-apply the payment", async () => {
    const inv = await createInvoice({ customerName: "Hoa Lee", items: [{ productId: "p1", productName: "Milo", quantity: 1, unit: "u", price: 100, lineTotal: 100 }], status: "unpaid", createdBy: "user", actor: "user", operationId: "seed3" });
    const { POST } = await import("./invoices/[id]/payments/route");
    const body = { amount: 40, operationId: "pay-attempt-1" };
    await POST(post(`/api/business/invoices/${inv.id}/payments`, body), { params: Promise.resolve({ id: inv.id }) });
    await POST(post(`/api/business/invoices/${inv.id}/payments`, body), { params: Promise.resolve({ id: inv.id }) });
    expect(store.count("payments")).toBe(1);
    expect(store.read(`invoices/${inv.id}`)).toMatchObject({ amountPaid: 40 });
  });
});

describe("B1 (route level) — the exact client retry shape: same stable operationId across a lost-response retry", () => {
  it("POST /invoices twice with the SAME operationId (what businessApi.ts + useActionId now send on retry): exactly one invoice", async () => {
    const { POST } = await import("./invoices/route");
    const body = { customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: 2, price: 10 }], operationId: "client-retry-key-1" };
    const a = await POST(post("/api/business/invoices", body));
    const b = await POST(post("/api/business/invoices", body)); // simulates useActionId.current() reusing the SAME id on retry
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect((await a.json()).invoice.id).toBe((await b.json()).invoice.id);
    expect(store.count("invoices")).toBe(1);
  });

  it("POST /invoices/:id/payments twice with the SAME operationId: exactly one payment applied", async () => {
    const inv = await createInvoice({ customerName: "Hoa Lee", items: [{ productId: "p1", productName: "Milo", quantity: 1, unit: "u", price: 100, lineTotal: 100 }], status: "unpaid", createdBy: "user", actor: "user", operationId: "seed-pay" });
    const { POST } = await import("./invoices/[id]/payments/route");
    const body = { amount: 40, operationId: "client-pay-retry-1" };
    await POST(post(`/api/business/invoices/${inv.id}/payments`, body), { params: Promise.resolve({ id: inv.id }) });
    await POST(post(`/api/business/invoices/${inv.id}/payments`, body), { params: Promise.resolve({ id: inv.id }) });
    expect(store.count("payments")).toBe(1);
    expect(store.read(`invoices/${inv.id}`)).toMatchObject({ amountPaid: 40 });
  });

  it("PATCH /invoices/:id twice with the SAME operationId: exactly one edit applied, not two", async () => {
    const inv = await createInvoice({ customerName: "Hoa Lee", items: [{ productId: "p1", productName: "Milo", quantity: 1, unit: "u", price: 10, lineTotal: 10 }], status: "unpaid", createdBy: "user", actor: "user", operationId: "seed-edit" });
    const { PATCH } = await import("./invoices/[id]/route");
    const body = { shipping: 5, reason: "add shipping", operationId: "client-edit-retry-1" };
    await PATCH(patch(`/api/business/invoices/${inv.id}`, body), { params: Promise.resolve({ id: inv.id }) });
    await PATCH(patch(`/api/business/invoices/${inv.id}`, body), { params: Promise.resolve({ id: inv.id }) });
    expect(store.list("invoiceLogs").filter(([, l]) => l.message === "add shipping")).toHaveLength(1);
  });

  it("a stale key reused for a materially DIFFERENT invoice request is rejected (409), not silently mismatched to the old result", async () => {
    const { POST } = await import("./invoices/route");
    const key = "reused-key-1";
    await POST(post("/api/business/invoices", { customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: 1, price: 10 }], operationId: key }));
    const res = await POST(post("/api/business/invoices", { customerName: "Someone Else Entirely", items: [{ productName: "Milo", quantity: 1, price: 10 }], operationId: key }));
    expect(res.status).toBe(409);
    expect(store.count("invoices")).toBe(1);
  });
});

describe("B2 (route level) — invalid financial input is rejected with no write, matching the AI/tool path's own boundary check", () => {
  it("POST /invoices rejects Infinity/NaN price even though the manual route's own field validator already covers this (defense in depth)", async () => {
    const { POST } = await import("./invoices/route");
    for (const price of [Infinity, NaN, -5]) {
      const res = await POST(post("/api/business/invoices", { customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: 1, price }] }));
      expect(res.status).toBe(400);
    }
    expect(store.count("invoices")).toBe(0);
  });

  it("POST /products rejects a negative cost, not just a negative defaultPrice", async () => {
    const { POST } = await import("./products/route");
    const res = await POST(post("/api/business/products", { name: "X", defaultPrice: 5, cost: -1 }));
    expect(res.status).toBe(400);
    expect(store.count("products")).toBe(0);
  });
});

describe("delivery orders (manual)", () => {
  it("POST /invoices with delivery=true saves a $0 delivery order; PATCH with convertDelivery sets final prices once", async () => {
    const { POST } = await import("./invoices/route");
    const { PATCH } = await import("./invoices/[id]/route");
    const res = await POST(post("/api/business/invoices", { customerName: "Hoa Lee", delivery: true, items: [{ productId: "p1", productName: "Milo", quantity: 4, price: 0 }] }));
    expect(res.status).toBe(201);
    const { invoice } = await res.json();
    expect(invoice).toMatchObject({ paymentStatus: "unpaid", total: 0, delivery: { status: "open" } });

    const items = [{ productId: "p1", productName: "Milo", quantity: 4, unit: "unit", price: 25 }];
    const ok = await PATCH(patch(`/api/business/invoices/${invoice.id}`, { items, reason: "chốt giá", convertDelivery: true, operationId: "convert-key-1" }), { params: Promise.resolve({ id: invoice.id }) });
    expect(ok.status).toBe(200);
    const doc = store.read(`invoices/${invoice.id}`)!;
    expect(doc).toMatchObject({ total: 100, balance: 100, paymentStatus: "unpaid" });
    expect((doc.delivery as { status: string }).status).toBe("converted");

    // Retrying the same request (same key) is a no-op replay, not a conflict.
    const replay = await PATCH(patch(`/api/business/invoices/${invoice.id}`, { items, reason: "chốt giá", convertDelivery: true, operationId: "convert-key-1" }), { params: Promise.resolve({ id: invoice.id }) });
    expect(replay.status).toBe(200);
    // A second, different conversion is refused.
    const again = await PATCH(patch(`/api/business/invoices/${invoice.id}`, { items, reason: "again", convertDelivery: true }), { params: Promise.resolve({ id: invoice.id }) });
    expect(again.status).toBe(400);
  });

  it("a normal manual invoice is not tagged", async () => {
    const { POST } = await import("./invoices/route");
    const res = await POST(post("/api/business/invoices", { customerName: "Hoa Lee", delivery: "yes", items: [{ productName: "Milo", quantity: 1, price: 10 }] }));
    expect((await res.json()).invoice.delivery).toBeUndefined();
  });
});
