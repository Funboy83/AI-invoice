import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";

vi.mock("firebase/firestore", async () => (await import("@/test/fakeFirestore")).clientModule);
vi.mock("@/lib/firebase", () => ({ db: {}, firebaseApp: {} }));

import { store, adminFacade } from "@/test/fakeFirestore";
import { __setAdminDbForTests } from "@/lib/server/firebaseAdmin";
import { HttpError, type AuthedUser } from "./auth";
import { apiConfig, apiConfigProblem, authenticateApiKey, externalTools, parseApiKeys, runExternalTool } from "./externalApi";
import type { Invoice } from "@/lib/types";

const KEY = "k".repeat(40);
const OTHER_KEY = "z".repeat(40);
const ENV = { AI_API_ENABLED: "true", AI_API_KEYS: `wife@example.com:${KEY}, husband@example.com:${OTHER_KEY}` };
const wife: AuthedUser = { uid: "wife", email: "wife@example.com", storeId: "main" };
const husband: AuthedUser = { uid: "husband", email: "husband@example.com", storeId: "main" };

type R = Record<string, unknown> & { status: string; invoice?: Invoice; confirmToken?: string; preview?: Record<string, unknown> };
const run = (name: string, args: Record<string, unknown>, user = wife) => runExternalTool(name, args, user) as Promise<R>;
const invoices = () => [...store.docs.keys()].filter((k) => k.startsWith("invoices/"));

beforeEach(() => {
  store.reset();
  __setAdminDbForTests(adminFacade() as unknown as Firestore);
  store.put("storeMembers/wife", { uid: "wife", email: "wife@example.com", storeId: "main", addedAt: 1, addedByEmail: "a@x.com" });
  store.put("storeMembers/husband", { uid: "husband", email: "husband@example.com", storeId: "main", addedAt: 1, addedByEmail: "a@x.com" });
  store.put("customers/c1", { name: "Hoa Lee", aliases: [], active: true, defaultShipping: 0, createdAt: 1, updatedAt: 1 });
  store.put("products/p1", { name: "Milo", aliases: [], defaultUnit: "thùng", defaultPrice: 29, quantity: 100, active: true, createdAt: 1, updatedAt: 1 });
  store.put("products/p2", { name: "Bột giặt", aliases: [], defaultUnit: "bao", defaultPrice: 0, active: true, createdAt: 1, updatedAt: 1 });
});

describe("turning the door on", () => {
  it("is off unless AI_API_ENABLED=true and at least one valid key is set", () => {
    expect(apiConfig({})).toBeNull();
    expect(apiConfig({ AI_API_KEYS: ENV.AI_API_KEYS })).toBeNull();
    expect(apiConfig({ AI_API_ENABLED: "true" })).toBeNull();
    expect(apiConfig(ENV)?.keys).toHaveLength(2);
  });

  it("accepts a value pasted with surrounding quotes", () => {
    expect(parseApiKeys(`"wife@example.com:${KEY}"`)).toEqual([{ email: "wife@example.com", key: KEY }]);
  });

  it("explains a switched-on door whose keys are missing or mistyped, and stays quiet when it is off or fine", () => {
    expect(apiConfigProblem({})).toBeNull();
    expect(apiConfigProblem(ENV)).toBeNull();
    expect(apiConfigProblem({ AI_API_ENABLED: "true" })).toMatch(/AI_API_KEYS is empty/);
    expect(apiConfigProblem({ AI_API_ENABLED: "true", AI_API_KEYS: KEY })).toMatch(/no valid entry/);
    expect(apiConfigProblem({ AI_API_ENABLED: "true", AI_API_KEYS: `wife@example.com:Bearer ${KEY}` })).toMatch(/no valid entry/);
  });

  it("ignores short or malformed keys, so a weak key never opens it", () => {
    expect(parseApiKeys("wife@example.com:short")).toEqual([]);
    expect(parseApiKeys(`no-email:${KEY}`)).toEqual([]);
    expect(parseApiKeys(`Wife@Example.com:${KEY}`)).toEqual([{ email: "wife@example.com", key: KEY }]);
  });
});

describe("who may call", () => {
  const cfg = apiConfig(ENV)!;
  it("rejects a missing or wrong key with 401", async () => {
    await expect(authenticateApiKey(cfg, "")).rejects.toMatchObject({ status: 401 });
    await expect(authenticateApiKey(cfg, "x".repeat(40))).rejects.toMatchObject({ status: 401 });
  });
  it("maps a key to its store member", async () => {
    expect(await authenticateApiKey(cfg, KEY)).toEqual(wife);
    expect(await authenticateApiKey(cfg, OTHER_KEY)).toEqual(husband);
  });
  it("rejects a valid key whose person was removed from the store (403), checked live", async () => {
    store.docs.delete("storeMembers/husband");
    const err = await authenticateApiKey(cfg, OTHER_KEY).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(403);
  });
});

describe("what an outside AI can do", () => {
  it("offers read tools plus the two create tools and confirmAction — never payments or edits", () => {
    const names = externalTools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["searchCustomer", "getCustomerDebt", "getDeliveries", "createInvoiceDraft", "createDeliveryOrder", "confirmAction"]));
    for (const banned of ["recordPayment", "updateInvoice", "convertDelivery", "createCustomer", "updateProduct", "addInvoiceItem", "requestUserInput"]) {
      expect(names).not.toContain(banned);
    }
    const delivery = externalTools.find((t) => t.name === "createDeliveryOrder")!;
    expect((delivery.inputSchema.properties as Record<string, unknown>).confirmed).toBeUndefined();
  });

  it("refuses a tool that isn't on the list, even if the chat has it", async () => {
    const res = await run("recordPayment", { invoiceId: "x", amount: 5 });
    expect(res.status).toBe("error");
    expect(store.count("payments")).toBe(0);
  });

  it("runs read tools on the shared tool layer", async () => {
    const res = (await run("searchCustomer", { query: "hoa lee" })) as unknown as { results: { name: string }[] };
    expect(res.results[0].name).toBe("Hoa Lee");
  });
});

describe("create → preview → confirmAction", () => {
  it("a delivery order is only previewed until confirmed, then saved exactly once", async () => {
    const preview = await run("createDeliveryOrder", { customerName: "hoa lee", items: [{ productName: "milo", quantity: 5 }] });
    expect(preview.status).toBe("needs_confirmation");
    expect(preview.confirmToken).toBeTruthy();
    expect(preview.preview).toMatchObject({ customer: { id: "c1", name: "Hoa Lee" }, total: 0, unpricedItems: ["Milo"] });
    expect(invoices()).toHaveLength(0);

    const saved = await run("confirmAction", { confirmToken: preview.confirmToken });
    expect(saved.status).toBe("created");
    expect(saved.invoice!.delivery).toEqual({ status: "open" });
    expect(saved.invoice!.items[0]).toMatchObject({ productId: "p1", quantity: 5, price: 0 });
    expect(invoices()).toHaveLength(1);

    // A retry or double tap returns the same invoice, never a second one.
    const again = await run("confirmAction", { confirmToken: preview.confirmToken });
    expect(again.invoice!.id).toBe(saved.invoice!.id);
    expect(invoices()).toHaveLength(1);
  });

  it("an invoice draft saves the previewed prices and totals; an unknown price stays incomplete", async () => {
    const preview = await run("createInvoiceDraft", {
      customerName: "Hoa Lee",
      items: [
        { productName: "milo", quantity: 2 },
        { productName: "bot giat", quantity: 3 },
      ],
    });
    expect(preview.status).toBe("needs_confirmation");
    expect(preview.preview).toMatchObject({ subtotal: 58, total: 58, incompleteItems: ["Bột giặt"] });
    expect(invoices()).toHaveLength(0);

    // The catalog price changes between preview and yes: what she saw is what is saved.
    store.put("products/p1", { name: "Milo", aliases: [], defaultUnit: "thùng", defaultPrice: 35, quantity: 100, active: true, createdAt: 1, updatedAt: 2 });
    const saved = await run("confirmAction", { confirmToken: preview.confirmToken });
    expect(saved.status).toBe("created");
    expect(saved.invoice!.paymentStatus).toBe("draft");
    expect(saved.invoice!.items[0]).toMatchObject({ productId: "p1", price: 29, lineTotal: 58 });
    expect(saved.invoice!.items[1]).toMatchObject({ productId: "p2", price: 0, incomplete: true });
    expect(saved.invoice!.total).toBe(58);
  });

  it("passes matching questions straight back instead of previewing", async () => {
    const res = await run("createDeliveryOrder", { customerName: "nobody at all", items: [{ productName: "milo", quantity: 1 }] });
    expect(res.status).toBe("needs_new_customer");
    expect(store.count("apiPendingActions")).toBe(0);
  });

  it("a token only works for the person who previewed it, and only for 30 minutes", async () => {
    const preview = await run("createDeliveryOrder", { customerId: "c1", items: [{ productId: "p1", quantity: 1 }] });
    expect((await run("confirmAction", { confirmToken: preview.confirmToken }, husband)).status).toBe("not_found");
    expect((await run("confirmAction", { confirmToken: "made-up" })).status).toBe("not_found");

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60 * 1000);
    try {
      expect((await run("confirmAction", { confirmToken: preview.confirmToken })).status).toBe("expired");
    } finally {
      vi.restoreAllMocks();
    }
    expect(invoices()).toHaveLength(0);
  });

  it("stores the token only as a hash", async () => {
    const preview = await run("createDeliveryOrder", { customerId: "c1", items: [{ productId: "p1", quantity: 1 }] });
    const ids = [...store.docs.keys()].filter((k) => k.startsWith("apiPendingActions/"));
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toContain(preview.confirmToken!);
  });
});
