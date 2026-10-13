import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("firebase/firestore", async () => (await import("@/test/fakeFirestore")).clientModule);
vi.mock("@/lib/firebase", () => ({ db: {}, firebaseApp: {} }));

import type { Firestore } from "firebase-admin/firestore";
import { store } from "@/test/fakeFirestore";
import { getAdminDb } from "./firebaseAdmin";
import { __setDefaultStoreForTests, activeStoreId, runInStore } from "./storeContext";
import {
  createCustomer,
  createInvoice,
  createProduct,
  getAllCustomers,
  getAllInvoices,
  getAllPayments,
  getAllProducts,
  getCustomInvoiceDefaults,
  getCustomerDebt,
  getInvoice,
  recordPayment,
  saveInvoicePrintInfo,
} from "./businessStore";
import { executeTool } from "@/lib/ai/tools";
import { isMember, memberByEmail } from "./membership";
import { HttpError, requestedStoreId, type AuthedUser } from "./auth";
import { authenticateApiKey, parseApiKeys, runExternalTool } from "./externalApi";
import { acceptMessage } from "./chatJobs";
import { driveJob } from "./agentRunner";
import { storeCollectionPath, STORES } from "@/lib/stores";
import { resetRunnerEnv, scriptedModel, deps, text, toolUse } from "@/test/runnerKit";
import type { InvoiceLineItem } from "@/lib/types";

/**
 * The promise of "two stores in one app": the Wholesale store and the Phone store never see or change each other's
 * customers, products, invoices, payments, invoice numbers or settings — through the business functions, the AI
 * tools, the outside-AI API keys, or an AI chat job — and a request that never said which store it is for is
 * refused instead of landing in some default store.
 */

const KEY = "k".repeat(40);
const PHONE_KEY = "p".repeat(40);

const line = (over: Partial<InvoiceLineItem> = {}): InvoiceLineItem => ({
  productId: "p1",
  productName: "Milo",
  quantity: 10,
  unit: "thùng",
  price: 29,
  lineTotal: 290,
  ...over,
});
const newInvoice = (customerName: string, customerId?: string) =>
  createInvoice({ customerId, customerName, items: [line()], status: "unpaid", createdBy: "user", actor: "user" });

const inMain = <T,>(fn: () => Promise<T>) => runInStore("main", fn);
const inPhone = <T,>(fn: () => Promise<T>) => runInStore("phone", fn);

beforeEach(() => {
  resetRunnerEnv(); // fresh fake Firestore, wife is a member
  __setDefaultStoreForTests(null); // in this file, a missing store must fail loudly
});
afterEach(() => __setDefaultStoreForTests("main"));

describe("where each store's data lives", () => {
  it("Wholesale keeps the existing top-level collections; the Phone store lives under stores/phone", () => {
    expect(storeCollectionPath("main", "invoices")).toBe("invoices");
    expect(storeCollectionPath("phone", "invoices")).toBe("stores/phone/invoices");
  });

  it("an unknown store id never becomes a path", () => {
    expect(() => storeCollectionPath("evil", "invoices")).toThrow();
    expect(() => storeCollectionPath("", "invoices")).toThrow();
    expect(() => runInStore("evil", () => 1)).toThrow();
  });

  it("refuses to read or write anything when no store was chosen", async () => {
    expect(() => activeStoreId()).toThrow(/No store selected/);
    await expect(createProduct({ name: "Milo", defaultPrice: 1 })).rejects.toThrow(/No store selected/);
    await expect(getAllInvoices()).rejects.toThrow(/No store selected/);
    expect(store.docs.size).toBe(1); // only the membership doc seeded by resetRunnerEnv
  });

  it("existing Wholesale data is read as-is, without moving it", async () => {
    store.put("products/old1", { name: "Old product", aliases: [], defaultUnit: "unit", defaultPrice: 5, active: true, createdAt: 1, updatedAt: 1 });
    expect((await inMain(getAllProducts)).map((p) => p.id)).toEqual(["old1"]);
    expect(await inPhone(getAllProducts)).toEqual([]);
    expect(store.read("products/old1")).toBeDefined();
  });
});

describe("business data never crosses stores", () => {
  it("products, customers and invoices created in one store are invisible in the other", async () => {
    await inMain(() => createProduct({ name: "Milo", defaultPrice: 29 }));
    await inMain(() => createCustomer({ name: "Hoa Lee" }));
    await inMain(() => newInvoice("Hoa Lee"));
    await inPhone(() => createProduct({ name: "iPhone 15", defaultPrice: 700 }));
    await inPhone(() => createCustomer({ name: "Anh Tuấn" }));
    await inPhone(() => newInvoice("Anh Tuấn"));

    expect((await inMain(getAllProducts)).map((p) => p.name)).toEqual(["Milo"]);
    expect((await inPhone(getAllProducts)).map((p) => p.name)).toEqual(["iPhone 15"]);
    expect((await inMain(getAllCustomers)).map((c) => c.name)).toEqual(["Hoa Lee"]);
    expect((await inPhone(getAllCustomers)).map((c) => c.name)).toEqual(["Anh Tuấn"]);
    expect((await inMain(getAllInvoices)).map((i) => i.customerName)).toEqual(["Hoa Lee"]);
    expect((await inPhone(getAllInvoices)).map((i) => i.customerName)).toEqual(["Anh Tuấn"]);

    expect(store.count("invoices")).toBe(1);
    expect(store.count("stores/phone/invoices")).toBe(1);
  });

  it("each store numbers its own invoices (Wholesale from 2000, Phone store from 1000)", async () => {
    const a = await inMain(() => newInvoice("A"));
    const b = await inPhone(() => newInvoice("B"));
    const c = await inMain(() => newInvoice("C"));
    const d = await inPhone(() => newInvoice("D"));
    expect([a.invoiceNumber, c.invoiceNumber]).toEqual(["2000", "2001"]);
    expect([b.invoiceNumber, d.invoiceNumber]).toEqual(["1000", "1001"]);
    expect(store.read("counters/invoiceCounter")).toEqual({ value: 2001 });
    expect(store.read("stores/phone/counters/invoiceCounter")).toEqual({ value: 1001 });
  });

  it("an invoice id from one store is not found in the other, so it can't be paid or edited there", async () => {
    const wholesale = await inMain(() => newInvoice("Hoa Lee"));
    expect(await inPhone(() => getInvoice(wholesale.id))).toBeNull();
    await expect(inPhone(() => recordPayment({ invoiceId: wholesale.id, amount: 10, actor: "user" }))).rejects.toThrow();
    expect((await inMain(() => getInvoice(wholesale.id)))?.amountPaid).toBe(0);
    expect(store.count("payments")).toBe(0);
    expect(store.count("stores/phone/payments")).toBe(0);
  });

  it("a payment and the debt it changes stay in their own store", async () => {
    const hoa = await inMain(() => createCustomer({ name: "Hoa Lee" }));
    const tuan = await inPhone(() => createCustomer({ name: "Anh Tuấn" }));
    const inv1 = await inMain(() => newInvoice("Hoa Lee", hoa.id));
    const inv2 = await inPhone(() => newInvoice("Anh Tuấn", tuan.id));
    await inPhone(() => recordPayment({ invoiceId: inv2.id, amount: 90, actor: "user" }));

    expect((await inPhone(() => getCustomerDebt(tuan.id))).balance).toBe(200);
    expect((await inMain(() => getCustomerDebt(hoa.id))).balance).toBe(290);
    expect((await inMain(() => getInvoice(inv1.id)))?.amountPaid).toBe(0);
    expect(await inMain(getAllPayments)).toEqual([]);
    expect((await inPhone(getAllPayments)).map((p) => p.amount)).toEqual([90]);
    // A customer id from the other store has no debt here.
    expect((await inMain(() => getCustomerDebt(tuan.id))).balance).toBe(0);
  });

  it("custom invoice settings are kept per store", async () => {
    const inv = await inPhone(() => newInvoice("Anh Tuấn"));
    const from = { name: "Tri Phones", address: "1 Main St", phone: "111", email: "t@example.com" };
    await inPhone(() =>
      saveInvoicePrintInfo({
        invoiceId: inv.id,
        template: "simple",
        from,
        billTo: { address: "", phone: "" },
        shipTo: { name: "", address: "", phone: "", email: "" },
        date: "",
        dueDate: "",
        deliveryDate: "",
        po: "",
        notes: "",
        terms: "30 days",
      })
    );
    expect((await inPhone(getCustomInvoiceDefaults)).from.name).toBe("Tri Phones");
    expect((await inMain(getCustomInvoiceDefaults)).from.name).not.toBe("Tri Phones");
    expect(store.read("settings/customInvoiceDefaults")).toBeUndefined();
  });
});

describe("the AI tools only see the selected store", () => {
  beforeEach(async () => {
    await inMain(() => createCustomer({ name: "Hoa Lee" }));
    await inMain(() => createProduct({ name: "Milo", defaultPrice: 29 }));
    await inPhone(() => createCustomer({ name: "Anh Tuấn" }));
    await inPhone(() => createProduct({ name: "iPhone 15", defaultPrice: 700 }));
  });

  it("searching finds only this store's customers and products", async () => {
    const search = (tool: string, query: string) => executeTool(tool, { query }) as Promise<{ results?: { name: string }[] }>;
    expect((await inPhone(() => search("searchCustomer", "Hoa Lee"))).results ?? []).toEqual([]);
    expect(((await inMain(() => search("searchCustomer", "Hoa Lee"))).results ?? []).map((c) => c.name)).toEqual(["Hoa Lee"]);
    expect((await inMain(() => search("searchProduct", "iPhone 15"))).results ?? []).toEqual([]);
    expect(((await inPhone(() => search("searchProduct", "iPhone 15"))).results ?? []).map((p) => p.name)).toEqual(["iPhone 15"]);
  });

  it("an AI invoice draft in the Phone store is saved there, never in Wholesale", async () => {
    const res = (await inPhone(() =>
      executeTool("createInvoiceDraft", { customerName: "Anh Tuấn", items: [{ productName: "iPhone 15", quantity: 1, price: 700 }] }, { operationId: "op-phone-1" })
    )) as { status: string; invoice?: { invoiceNumber: string } };
    expect(res.status).toBe("created");
    expect(res.invoice?.invoiceNumber).toBe("1000");
    expect(store.count("invoices")).toBe(0);
    expect(store.count("stores/phone/invoices")).toBe(1);
  });

  it("the AI can't use a Wholesale customer while working in the Phone store", async () => {
    const res = (await inPhone(() =>
      executeTool("createInvoiceDraft", { customerName: "Hoa Lee", items: [{ productName: "iPhone 15", quantity: 1, price: 700 }] })
    )) as { status: string };
    expect(res.status).not.toBe("created");
    expect(store.count("invoices")).toBe(0);
    expect(store.count("stores/phone/invoices")).toBe(0);
  });
});

describe("one login, every store — unknown or restricted stores refused", () => {
  it("a member may use both stores", async () => {
    expect(await isMember(getAdminDb() as Firestore, "wife", "main")).toBe(true);
    expect(await isMember(getAdminDb() as Firestore, "wife", "phone")).toBe(true);
    expect(await isMember(getAdminDb() as Firestore, "wife", "evil")).toBe(false);
    expect((await memberByEmail(getAdminDb() as Firestore, "wife@example.com", "phone"))?.storeId).toBe("phone");
    expect(await memberByEmail(getAdminDb() as Firestore, "wife@example.com", "evil")).toBeNull();
  });

  it("a member limited to some stores (stores: [...]) can't open the others", async () => {
    store.put("storeMembers/helper", { uid: "helper", email: "helper@example.com", storeId: "main", stores: ["main"], addedAt: 1, addedByEmail: "a@x.com" });
    expect(await isMember(getAdminDb() as Firestore, "helper", "main")).toBe(true);
    expect(await isMember(getAdminDb() as Firestore, "helper", "phone")).toBe(false);
    expect(await memberByEmail(getAdminDb() as Firestore, "helper@example.com", "phone")).toBeNull();
  });

  it("a browser request says its store in a header; none means Wholesale, unknown is refused", () => {
    const req = (h?: string) => new Request("http://localhost/api/x", { headers: h === undefined ? {} : { "x-store-id": h } });
    expect(requestedStoreId(req())).toBe("main");
    expect(requestedStoreId(req("phone"))).toBe("phone");
    expect(() => requestedStoreId(req("evil"))).toThrow(HttpError);
    expect(() => requestedStoreId(req("stores/phone"))).toThrow(HttpError);
  });
});

describe("outside-AI keys (Claude / MCP) each work on one store", () => {
  const cfg = { keys: parseApiKeys(`wife@example.com:${KEY}, wife@example.com:${PHONE_KEY}:phone, wife@example.com:${"x".repeat(40)}:evil`) };

  it("a key with :phone is a Phone store key; no suffix is Wholesale; an unknown store is ignored", () => {
    expect(cfg.keys.map((k) => k.storeId)).toEqual(["main", "phone"]);
  });

  it("each key only reads and writes its own store", async () => {
    await inMain(() => createCustomer({ name: "Hoa Lee" }));
    await inPhone(() => createCustomer({ name: "Anh Tuấn" }));
    const wholesaleUser = await authenticateApiKey(cfg, KEY);
    const phoneUser = await authenticateApiKey(cfg, PHONE_KEY);
    expect(phoneUser.storeId).toBe("phone");

    // "search" with an empty query lists every customer the key can see.
    const titles = async (user: AuthedUser) =>
      (((await runExternalTool("search", { query: "" }, user)) as { results: { title: string }[] }).results).map((r) => r.title);
    expect(await titles(wholesaleUser)).toEqual(["Customer: Hoa Lee"]);
    expect(await titles(phoneUser)).toEqual(["Customer: Anh Tuấn"]);
  });

  it("a preview made with the Phone key can't be confirmed with the Wholesale key", async () => {
    await inPhone(() => createProduct({ name: "iPhone 15", defaultPrice: 700 }));
    const phoneUser = await authenticateApiKey(cfg, PHONE_KEY);
    const wholesaleUser = await authenticateApiKey(cfg, KEY);
    const preview = (await runExternalTool("createProduct", { name: "Galaxy S24", defaultPrice: 600 }, phoneUser)) as { confirmToken: string };
    expect(preview.confirmToken).toBeTruthy();
    const wrong = (await runExternalTool("confirmAction", { confirmToken: preview.confirmToken }, wholesaleUser)) as { status: string };
    expect(wrong.status).toBe("not_found");
    expect(store.count("products")).toBe(0);
    const right = (await runExternalTool("confirmAction", { confirmToken: preview.confirmToken }, phoneUser)) as { status: string };
    expect(right.status).toBe("created");
    expect(store.count("stores/phone/products")).toBe(2);
    expect(store.count("products")).toBe(0);
  });
});

describe("AI chat jobs run in the store they were sent from", () => {
  const phoneWife: AuthedUser = { uid: "wife", email: "wife@example.com", storeId: "phone" };

  it("each store has its own conversation, and a Phone store job's tools write to the Phone store", async () => {
    await inPhone(() => createCustomer({ name: "Anh Tuấn" }));
    await inPhone(() => createProduct({ name: "iPhone 15", defaultPrice: 700 }));
    const { jobId } = await acceptMessage(phoneWife, { requestId: "phone-req-0000001", content: "Anh Tuấn 1 iPhone 15 700" });
    expect(jobId.startsWith("phone__wife__")).toBe(true);

    let systemText = "";
    const model = scriptedModel([
      [toolUse("toolu_1", "createInvoiceDraft", { customerName: "Anh Tuấn", items: [{ productName: "iPhone 15", quantity: 1, price: 700 }] })],
      [text("Đã tạo")],
    ]);
    const capture: typeof model.createMessage = async (params, opts) => {
      systemText = (params.system as { text: string }[]).map((b) => b.text).join("\n");
      return model.createMessage(params, opts);
    };
    await driveJob(jobId, deps({ createMessage: capture }));

    expect(systemText).toContain("Current store: Phone store");
    expect(store.count("stores/phone/invoices")).toBe(1);
    expect(store.count("invoices")).toBe(0);
    expect(store.list("chatConversations").map(([id]) => id)).toEqual(["phone__wife"]);
  });

  it("every configured store has a name and its own first invoice number", () => {
    expect(STORES.map((s) => [s.id, s.name])).toEqual([
      ["main", "Wholesale"],
      ["phone", "Phone store"],
    ]);
    expect(new Set(STORES.map((s) => s.firstInvoiceNumber)).size).toBe(STORES.length);
  });
});
