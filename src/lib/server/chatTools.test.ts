import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";

vi.mock("firebase/firestore", async () => (await import("@/test/fakeFirestore")).clientModule);
vi.mock("@/lib/firebase", () => ({ db: {}, firebaseApp: {} }));

import { store, adminFacade } from "@/test/fakeFirestore";
import { __setAdminDbForTests } from "@/lib/server/firebaseAdmin";
import { chatToolDefinitions, CHAT_MUTATING_TOOLS, executeChatTool } from "./chatTools";

type R = Record<string, unknown> & { status: string; preview?: Record<string, unknown> };
const run = (name: string, args: Record<string, unknown>, canConfirm = false, operationId = "op1") =>
  executeChatTool(name, args, { channel: "app", canConfirm, operationId }) as Promise<R>;

beforeEach(() => {
  store.reset();
  __setAdminDbForTests(adminFacade() as unknown as Firestore);
  store.put("products/p1", { name: "Milo", aliases: [], defaultUnit: "thùng", defaultPrice: 29, cost: 20, quantity: 5, active: true, createdAt: 1, updatedAt: 1 });
});

describe("in-app chat: admin tools (vendors, purchases)", () => {
  it("has the vendor and purchase tools, writes marked mutating with a confirmed flag", () => {
    const names = chatToolDefinitions.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["createVendor", "createPurchase", "recordVendorPayment", "cancelPurchase", "listVendors", "searchPurchases", "recordPayment"]));
    expect(CHAT_MUTATING_TOOLS.has("createPurchase")).toBe(true);
    expect(CHAT_MUTATING_TOOLS.has("listVendors")).toBe(false);
    const purchase = chatToolDefinitions.find((t) => t.name === "createPurchase")!;
    expect((purchase.input_schema as unknown as { properties: Record<string, unknown> }).properties.confirmed).toBeDefined();
    expect(new Set(names).size).toBe(names.length);
  });

  it("previews first; saves only when her reply confirms (canConfirm + confirmed=true)", async () => {
    const vendorAsk = await run("createVendor", { name: "Ngân" });
    expect(vendorAsk.status).toBe("needs_confirmation");
    expect(store.count("vendors")).toBe(0);
    // confirmed=true outside a reply to the question is still only a preview.
    expect((await run("createVendor", { name: "Ngân", confirmed: true })).status).toBe("needs_confirmation");
    const v = await run("createVendor", { name: "Ngân", confirmed: true }, true);
    expect(v.status).toBe("created");

    const args = { vendorName: "ngan", vendorInvoiceNumber: "N1", items: [{ productName: "milo", quantity: 10, cost: 21 }] };
    const ask = await run("createPurchase", args);
    expect(ask.status).toBe("needs_confirmation");
    expect(ask.preview).toMatchObject({ total: 210, stock: [{ productName: "Milo", stockNow: 5, stockAfter: 15 }] });
    expect(store.count("purchases")).toBe(0);
    const saved = await run("createPurchase", { ...args, confirmed: true }, true, "op2");
    expect(saved.status).toBe("created");
    expect(store.read("products/p1")).toMatchObject({ quantity: 15, cost: 21 });
    // The same tool call retried (same operation id) never adds stock twice.
    await run("createPurchase", { ...args, confirmed: true }, true, "op2");
    expect(store.read("products/p1")).toMatchObject({ quantity: 15 });
  });

  it("reads run straight away", async () => {
    const res = (await run("listVendors", {})) as unknown as { vendors: unknown[] };
    expect(res.vendors).toEqual([]);
  });
});
