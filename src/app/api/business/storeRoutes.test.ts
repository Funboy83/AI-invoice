import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { NextRequest } from "next/server";
import { store, adminFacade } from "@/test/fakeFirestore";
import { __setAdminDbForTests } from "@/lib/server/firebaseAdmin";
import { __setDefaultStoreForTests } from "@/lib/server/storeContext";
import type { AuthedUser } from "@/lib/server/auth";

/** The manual business routes write into the store the signed-in request was authenticated for, and only there. */
const mockAuthenticate = vi.fn<(req: Request) => Promise<AuthedUser>>();
vi.mock("@/lib/server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/auth")>();
  return { ...actual, authenticate: (req: Request) => mockAuthenticate(req) };
});

const post = (path: string, body: unknown) =>
  new NextRequest(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  store.reset();
  __setAdminDbForTests(adminFacade() as unknown as Firestore);
  __setDefaultStoreForTests(null); // the route itself must pick the store
  mockAuthenticate.mockReset();
});
afterEach(() => __setDefaultStoreForTests("main"));

describe("business routes follow the selected store", () => {
  it("a product added while the Phone store is selected is saved in the Phone store only", async () => {
    mockAuthenticate.mockResolvedValue({ uid: "wife", email: "wife@example.com", storeId: "phone" });
    const { POST } = await import("./products/route");
    const res = await POST(post("/api/business/products", { name: "iPhone 15", defaultPrice: 700 }));
    expect(res.status).toBe(201);
    expect(store.count("stores/phone/products")).toBe(1);
    expect(store.count("products")).toBe(0);
  });

  it("the same route with Wholesale selected writes the top-level collections, as before", async () => {
    mockAuthenticate.mockResolvedValue({ uid: "wife", email: "wife@example.com", storeId: "main" });
    const { POST } = await import("./invoices/route");
    const res = await POST(post("/api/business/invoices", { customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: 1, price: 29, unit: "thùng" }] }));
    expect(res.status).toBe(201);
    expect((await res.json()).invoice.invoiceNumber).toBe("2000");
    expect(store.count("invoices")).toBe(1);
    expect(store.count("stores/phone/invoices")).toBe(0);
  });
});
