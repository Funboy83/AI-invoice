import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { NextRequest } from "next/server";
import { store, adminFacade } from "@/test/fakeFirestore";
import { __setAdminDbForTests } from "@/lib/server/firebaseAdmin";
import { HttpError, type AuthedUser } from "@/lib/server/auth";

/** Route tests for the "Buy from vendor" endpoints: membership required, input validated, no partial write. */
const mockAuthenticate = vi.fn<(req: Request) => Promise<AuthedUser>>();
vi.mock("@/lib/server/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/auth")>();
  return { ...actual, authenticate: (req: Request) => mockAuthenticate(req) };
});

const req = (method: string, path: string, body?: unknown) =>
  new NextRequest(`http://localhost${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeEach(() => {
  store.reset();
  __setAdminDbForTests(adminFacade() as unknown as Firestore);
  mockAuthenticate.mockReset();
  mockAuthenticate.mockResolvedValue({ uid: "u", email: "u@example.com", storeId: "main" });
  store.put("products/milo", { name: "Milo", aliases: [], defaultUnit: "thùng", defaultPrice: 30, quantity: 5, active: true, createdAt: 1, updatedAt: 1 });
  store.put("vendors/v1", { name: "Costco", active: true, createdAt: 1, updatedAt: 1 });
});

const good = { vendorId: "v1", vendorInvoiceNumber: "INV-9", dateKey: "2026-10-15", items: [{ productId: "milo", quantity: 2, cost: 10 }], updateCost: true };

describe("purchases routes", () => {
  it("rejects a non-member with no write", async () => {
    mockAuthenticate.mockRejectedValue(new HttpError(403, "not a member"));
    const { POST } = await import("./purchases/route");
    expect((await POST(req("POST", "/api/business/purchases", good))).status).toBe(403);
    expect(store.count("purchases")).toBe(0);
    const vendors = await import("./vendors/route");
    expect((await vendors.GET(req("GET", "/api/business/vendors"))).status).toBe(403);
  });

  it("saves a purchase and reports what is owed per vendor", async () => {
    const { POST } = await import("./purchases/route");
    const res = await POST(req("POST", "/api/business/purchases", good));
    expect(res.status).toBe(201);
    expect(store.read("products/milo")).toMatchObject({ quantity: 7, cost: 10 });
    const vendors = await import("./vendors/route");
    const data = await (await vendors.GET(req("GET", "/api/business/vendors"))).json();
    expect(data.owed).toEqual({ v1: 20 });
  });

  it("rejects bad input (quantity 0, bad date, negative cost) with no write", async () => {
    const { POST } = await import("./purchases/route");
    for (const bad of [
      { ...good, items: [{ productId: "milo", quantity: 0, cost: 10 }] },
      { ...good, dateKey: "2026-02-30" },
      { ...good, items: [{ productId: "milo", quantity: 1, cost: -1 }] },
      { ...good, items: [] },
    ]) {
      expect((await POST(req("POST", "/api/business/purchases", bad))).status).toBe(400);
    }
    expect(store.count("purchases")).toBe(0);
    expect(store.read("products/milo")).toMatchObject({ quantity: 5 });
  });
});
