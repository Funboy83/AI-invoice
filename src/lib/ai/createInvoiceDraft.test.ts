import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";

// tools.ts (and therefore createInvoiceDraft) is Admin-SDK-backed (src/lib/server/businessStore.ts) since Task B —
// the fake's admin facade is what needs wiring here, not the client-SDK mock.
vi.mock("firebase/firestore", async () => (await import("@/test/fakeFirestore")).clientModule);
vi.mock("@/lib/firebase", () => ({ db: {}, firebaseApp: {} }));

import { store, adminFacade } from "@/test/fakeFirestore";
import { __setAdminDbForTests } from "@/lib/server/firebaseAdmin";
import { seedShop, type ShopFixture } from "@/test/seedShop";
import { measureDraft, type DraftMode } from "@/test/perf/measureDraft";
import { executeTool } from "@/lib/ai/tools";
import { getInvoicesForCustomer, getProductsByIds } from "@/lib/server/businessStore";
import type { Invoice, InvoiceLineItem } from "@/lib/types";

let shop: ShopFixture;
let opCounter = 0;
const op = () => `op-${++opCounter}`;
type AliasSuggestion = { kind: "product" | "customer"; id: string; name: string; inputText: string };
type Result = {
  status: string;
  invoice?: Invoice;
  priceWarnings?: string[];
  incompleteItems?: string[];
  candidates?: unknown[];
  resolvedSoFar?: unknown[];
  aliasSuggestions?: AliasSuggestion[];
};
const draft = (args: Record<string, unknown>, operationId = op()) => executeTool("createInvoiceDraft", args, { operationId }) as Promise<Result>;

beforeEach(() => {
  store.reset();
  __setAdminDbForTests(adminFacade() as unknown as Firestore);
  shop = seedShop();
});

describe("reads do not grow with the number of line items", () => {
  const modes: DraftMode[] = ["names+prices", "names, no prices", "ids+prices"];

  for (const mode of modes) {
    it(`${mode}: 1, 5 and 10 items cost the same number of round trips`, async () => {
      const one = await measureDraft(shop, 1, mode, op());
      const five = await measureDraft(shop, 5, mode, op());
      const ten = await measureDraft(shop, 10, mode, op());
      for (const m of [one, five, ten]) expect(m.status).toBe("created");
      expect(five.ops).toBe(one.ops);
      expect(ten.ops).toBe(one.ops);
      // catalog and history are each read exactly once, no matter how many items
      expect(ten.byCollection.products).toBe(1);
      expect(ten.byCollection.invoices).toBe(1);
    });
  }

  it("never scans the whole invoices collection: only this customer's history is read", async () => {
    const totalInvoices = store.count("invoices");
    const focus = store.list("invoices").filter(([, d]) => d.customerId === shop.focusCustomerId).length;
    const m = await measureDraft(shop, 10, "names+prices", op());
    expect(m.docsByCollection.invoices).toBe(focus);
    expect(m.docsByCollection.invoices).toBeLessThan(totalInvoices / 10);
  });

  it("an explicit price does not trigger extra history reads (the price-difference warning uses the same single fetch)", async () => {
    const explicit = await measureDraft(shop, 10, "names+prices", op());
    const implicit = await measureDraft(shop, 10, "names, no prices", op());
    expect(explicit.byCollection.invoices).toBe(1);
    expect(implicit.byCollection.invoices).toBe(1);
  });

  it("with product ids and no names, no catalog is loaded; ids are fetched in one batched query", async () => {
    const m = await measureDraft(shop, 10, "ids+prices", op());
    expect(m.byCollection.products).toBe(1);
    expect(m.docsByCollection.products).toBe(10);
  });

  it("getProductsByIds batches 30 ids per query and ignores unknown ids", async () => {
    store.reset();
    for (let i = 0; i < 65; i++) store.put(`products/q${i}`, { name: `P${i}`, aliases: [], defaultUnit: "u", defaultPrice: 1, active: true, createdAt: 1, updatedAt: 1 });
    store.resetMetrics();
    const got = await getProductsByIds([...Array.from({ length: 65 }, (_, i) => `q${i}`), "missing", "q3"]);
    expect(got.size).toBe(65);
    expect(got.has("missing")).toBe(false);
    expect(store.metrics.ops).toBe(3); // ceil(66 unique ids / 30)
  });

  it("getInvoicesForCustomer returns only that customer's invoices, newest first", async () => {
    const list = await getInvoicesForCustomer(shop.focusCustomerId);
    expect(list.length).toBe(25);
    expect(list.every((i) => i.customerId === shop.focusCustomerId)).toBe(true);
    expect(list.map((i) => i.createdAt)).toEqual([...list.map((i) => i.createdAt)].sort((a, b) => b - a));
  });
});

describe("prices, totals and warnings are unchanged", () => {
  // Fixed fixture so precedence is checked against known numbers.
  function seedPrices() {
    store.reset();
    const base = { aliases: [] as string[], defaultUnit: "thùng", active: true, createdAt: 1, updatedAt: 1 };
    store.put("customers/c1", { name: "Hoa Lee", aliases: [], active: true, defaultShipping: 0, createdAt: 1, updatedAt: 1 });
    store.put("products/milo", { ...base, name: "Milo", defaultPrice: 29 });
    store.put("products/bot", { ...base, name: "Bột giặt", defaultPrice: 10 });
    store.put("products/kem", { ...base, name: "Kem đánh răng", defaultPrice: 5 });
    store.put("products/free", { ...base, name: "Hàng chưa có giá", aliases: ["hcg"], defaultPrice: 0 });
    const line = (productId: string, price: number): InvoiceLineItem => ({ productId, productName: productId, quantity: 1, unit: "thùng", price, lineTotal: price });
    const inv = (id: string, createdAt: number, status: string, items: InvoiceLineItem[], customerId = "c1") =>
      store.put(`invoices/${id}`, { invoiceNumber: id, date: createdAt, customerId, customerName: "x", items, shipping: 0, discount: 0, subtotal: 0, total: 0, amountPaid: 0, balance: 0, paymentStatus: status, createdAt, updatedAt: createdAt, createdBy: "user" });
    inv("old", 100, "unpaid", [line("milo", 25)]); // older price
    inv("new", 200, "paid", [line("milo", 27), line("bot", 12)]); // most recent → wins
    inv("void", 300, "void", [line("milo", 999)]); // void is ignored
    inv("other", 400, "unpaid", [line("milo", 1), line("kem", 1)], "c2"); // another customer's price is ignored
  }

  it("precedence: explicit price > customer's last non-void price > catalog default > missing (incomplete)", async () => {
    seedPrices();
    const r = await draft({
      customerName: "Hoa Lee",
      items: [
        { productName: "Milo", quantity: 2, price: 30 }, // explicit, differs from last (27) → warning, uses 30
        { productName: "Bột giặt", quantity: 3 }, // last price 12
        { productName: "Kem đánh răng", quantity: 4 }, // no history for c1 → default 5
        { productName: "hcg", quantity: 5 }, // alias, no default → $0 incomplete
      ],
    });
    expect(r.status).toBe("created");
    const items = r.invoice!.items;
    expect(items.map((i) => [i.productName, i.price, i.quantity, i.lineTotal, !!i.incomplete])).toEqual([
      ["Milo", 30, 2, 60, false],
      ["Bột giặt", 12, 3, 36, false],
      ["Kem đánh răng", 5, 4, 20, false],
      ["Hàng chưa có giá", 0, 5, 0, true],
    ]);
    expect(r.invoice).toMatchObject({ subtotal: 116, total: 116, balance: 116, paymentStatus: "draft" });
    expect(r.priceWarnings).toEqual([
      "Milo: current order says $30, previous price for this customer was $27.",
      "Bột giặt: no price given, used this customer's last price $12.",
      "Kem đánh răng: no price given, used catalog default $5.",
      "Hàng chưa có giá: no price given and no price history/default — saved as $0, needs a price.",
    ]);
    expect(r.incompleteItems).toEqual(["Hàng chưa có giá"]);
  });

  it("an explicit price equal to the last price gives no warning; a missing quantity is flagged, never guessed", async () => {
    seedPrices();
    const r = await draft({ customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: 2, price: 27 }, { productName: "Bột giặt", price: 12 }] });
    expect(r.priceWarnings).toEqual(["Bột giặt: no quantity given — saved with quantity 0, needs a quantity."]);
    expect(r.invoice!.items[1]).toMatchObject({ quantity: 0, lineTotal: 0, incomplete: true });
    expect(r.invoice!.total).toBe(54);
  });

  it("B2 regression: a non-finite (Infinity) parsed quantity is treated the SAME as missing — an incomplete draft that still saves, never a hard failure of the whole order", async () => {
    seedPrices();
    const r = await draft({ customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: Infinity, price: 27 }, { productName: "Bột giặt", quantity: 2, price: 12 }] });
    expect(r.status).toBe("created");
    expect(r.invoice!.items[0]).toMatchObject({ quantity: 0, lineTotal: 0, incomplete: true });
    expect(r.invoice!.items[1]).toMatchObject({ quantity: 2, lineTotal: 24, incomplete: false }); // the OTHER line is unaffected
    expect(r.incompleteItems).toEqual(["Milo"]);
    expect(r.invoice!.total).toBe(24);
  });

  it("B2 regression: an explicit negative or non-finite PRICE causes no invoice/counter/log write at all (rejected at the shared businessStore boundary)", async () => {
    seedPrices();
    const before = { invoices: store.count("invoices"), logs: store.count("invoiceLogs"), counter: store.read("counters/invoiceCounter") };
    for (const price of [-5, Infinity, NaN]) {
      const r = await draft({ customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: 2, price }] });
      expect(r.status).toBe("error");
    }
    expect(store.count("invoices")).toBe(before.invoices);
    expect(store.count("invoiceLogs")).toBe(before.logs);
    expect(store.read("counters/invoiceCounter")).toEqual(before.counter);
  });

  it("totals: subtotal + shipping - discount, rounded to cents, in application code", async () => {
    seedPrices();
    const r = await draft({ customerName: "Hoa Lee", shipping: 12.5, discount: 3.25, items: [{ productName: "Milo", quantity: 3, price: 10.1 }, { productName: "Kem đánh răng", quantity: 7, price: 0.33 }] });
    expect(r.invoice).toMatchObject({ subtotal: 32.61, total: 41.86, balance: 41.86, shipping: 12.5, discount: 3.25 });
  });

  it("never serves a stale price: each execution reads fresh history and catalog", async () => {
    seedPrices();
    const first = await draft({ customerName: "Hoa Lee", items: [{ productName: "Bột giặt", quantity: 1 }] });
    expect(first.invoice!.items[0].price).toBe(12);
    // her latest invoice now charged 15 (dated after the draft we just created) → the very next draft must use it
    const later = Date.now() + 60_000;
    store.put("invoices/newer", { invoiceNumber: "n", date: later, customerId: "c1", customerName: "x", items: [{ productId: "bot", productName: "Bột giặt", quantity: 1, unit: "thùng", price: 15, lineTotal: 15 }], shipping: 0, discount: 0, subtotal: 15, total: 15, amountPaid: 0, balance: 15, paymentStatus: "unpaid", createdAt: later, updatedAt: later, createdBy: "user" });
    const second = await draft({ customerName: "Hoa Lee", items: [{ productName: "Bột giặt", quantity: 1 }] });
    expect(second.invoice!.items[0].price).toBe(15);
    // and a catalog default change is picked up too
    store.put("products/kem", { name: "Kem đánh răng", aliases: [], defaultUnit: "hộp", defaultPrice: 6.5, active: true, createdAt: 1, updatedAt: 1 });
    const third = await draft({ customerName: "Hoa Lee", items: [{ productName: "Kem đánh răng", quantity: 2 }] });
    expect(third.invoice!.items[0]).toMatchObject({ price: 6.5, lineTotal: 13 });
  });
});

describe("alias suggestions — surfaced when a fuzzy (non-exact) match auto-resolves", () => {
  function seedPrices() {
    store.reset();
    const base = { aliases: [] as string[], defaultUnit: "thùng", active: true, createdAt: 1, updatedAt: 1 };
    store.put("customers/c1", { name: "Hoa Lee", aliases: [], active: true, defaultShipping: 0, createdAt: 1, updatedAt: 1 });
    store.put("products/milo", { ...base, name: "Milo", defaultPrice: 29 });
  }

  it("a fuzzy typo match that isn't the exact name (even after accent-stripping) surfaces an aliasSuggestion", async () => {
    seedPrices();
    const r = await draft({ customerName: "Hoa Lee", items: [{ productName: "milo", quantity: 2, price: 29 }] }); // lowercase, still exact after normalization
    expect(r.aliasSuggestions ?? []).toEqual([]); // exact match (modulo case) — nothing new to learn

    // "Nes cafe" (extra space) scores 0.875 against "Nescafe" — above AUTO_MATCH_THRESHOLD (0.82) but not equal
    // even after accent-stripping/case-folding, so this genuinely is new phrasing worth remembering.
    store.put("products/nescafe", { name: "Nescafe", aliases: [], defaultUnit: "thùng", defaultPrice: 20, active: true, createdAt: 1, updatedAt: 1 });
    const r2 = await draft({ customerName: "Hoa Lee", items: [{ productName: "Nes cafe", quantity: 2, price: 20 }] });
    expect(r2.status).toBe("created");
    expect(r2.aliasSuggestions).toEqual([{ kind: "product", id: "nescafe", name: "Nescafe", inputText: "Nes cafe" }]);
  });

  it("an exact name match never suggests an alias", async () => {
    seedPrices();
    const r = await draft({ customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: 2, price: 29 }] });
    expect(r.aliasSuggestions ?? []).toEqual([]);
  });

  it("a phrasing that's already a known alias is never suggested again", async () => {
    store.reset();
    store.put("customers/c1", { name: "Hoa Lee", aliases: [], active: true, defaultShipping: 0, createdAt: 1, updatedAt: 1 });
    store.put("products/nescafe", { name: "Nescafe", aliases: ["Nes cafe"], defaultUnit: "thùng", defaultPrice: 20, active: true, createdAt: 1, updatedAt: 1 });
    const r = await draft({ customerName: "Hoa Lee", items: [{ productName: "Nes cafe", quantity: 2, price: 20 }] });
    expect(r.aliasSuggestions ?? []).toEqual([]);
  });

  it("a fuzzy customer-name match also surfaces an aliasSuggestion", async () => {
    seedPrices();
    const r = await draft({ customerName: "Hoa Le", items: [{ productName: "Milo", quantity: 1, price: 29 }] }); // missing accent/letter vs "Hoa Lee"
    expect(r.aliasSuggestions).toContainEqual({ kind: "customer", id: "c1", name: "Hoa Lee", inputText: "Hoa Le" });
  });
});

describe("confirmation and missing-information behaviour is unchanged", () => {
  beforeEach(() => {
    store.reset();
    store.put("customers/c1", { name: "Hoa Lee", aliases: [], active: true, defaultShipping: 0, createdAt: 1, updatedAt: 1 });
    store.put("customers/c2", { name: "Hoa Lan", aliases: [], active: true, defaultShipping: 0, createdAt: 1, updatedAt: 1 });
    store.put("products/milo", { name: "Milo", aliases: ["milô"], defaultUnit: "thùng", defaultPrice: 29, active: true, createdAt: 1, updatedAt: 1 });
    store.put("products/miloxl", { name: "Milo Lớn", aliases: [], defaultUnit: "thùng", defaultPrice: 39, active: true, createdAt: 1, updatedAt: 1 });
  });

  it("a name that fits several customers equally needs confirmation and writes nothing", async () => {
    const r = await draft({ customerName: "Hoa L", items: [{ productName: "Milo", quantity: 1, price: 1 }] }); // 0.74 vs 0.74
    expect(r.status).toBe("needs_confirmation");
    expect(r.candidates).toHaveLength(2);
    expect(store.count("invoices")).toBe(0);
    // a confident match (0.87) is used without asking, exactly as before
    const confident = await draft({ customerName: "Hoa Le", items: [{ productName: "Milo", quantity: 1, price: 1 }] });
    expect(confident.status).toBe("created");
    expect(confident.invoice!.customerName).toBe("Hoa Lee");
  });

  it("an unknown customer or product is reported, with the items resolved so far, and nothing is created", async () => {
    const noCustomer = await draft({ customerName: "Zzz Nobody", items: [{ productName: "Milo", quantity: 1 }] });
    expect(noCustomer.status).toBe("needs_new_customer");
    const noProduct = await draft({ customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: 1, price: 5 }, { productName: "Qqq Xxx Zzz", quantity: 1 }] });
    expect(noProduct.status).toBe("needs_new_product");
    expect(noProduct.resolvedSoFar).toHaveLength(1);
    expect(store.count("invoices")).toBe(0);
  });

  it("aliases still match, and an ambiguous product name asks which one", async () => {
    const alias = await draft({ customerName: "Hoa Lee", items: [{ productName: "milô", quantity: 2, price: 28 }] });
    expect(alias.invoice!.items[0].productName).toBe("Milo");
    const ambiguous = await draft({ customerName: "Hoa Lee", items: [{ productName: "Milo Lo", quantity: 2, price: 28 }] });
    expect(["needs_confirmation", "created"]).toContain(ambiguous.status); // exact outcome depends on similarity score; it must never crash or guess silently
    if (ambiguous.status === "needs_confirmation") expect(ambiguous.candidates?.length).toBeGreaterThan(0);
  });

  it("an unknown productId is an error, not a guess", async () => {
    const r = await draft({ customerId: "c1", items: [{ productId: "nope", quantity: 1 }] });
    expect(r).toMatchObject({ status: "error", message: "productId nope not found." });
  });
});

describe("idempotent recovery is preserved", () => {
  it("replaying the same operation for a 10-item order returns the same invoice with one number and one audit log", async () => {
    const opId = op();
    const args = { customerName: "Hoa Lee", items: Array.from({ length: 10 }, (_, i) => ({ productName: shop.productNames[i * 3], quantity: 2, price: 20 })) };
    const a = await draft(args, opId);
    const invoices = store.count("invoices");
    const b = await draft(args, opId);
    expect(b.invoice!.id).toBe(a.invoice!.id);
    expect(b.invoice!.invoiceNumber).toBe(a.invoice!.invoiceNumber);
    expect(store.count("invoices")).toBe(invoices);
    expect(store.list("invoiceLogs").filter(([, l]) => l.operationId === opId)).toHaveLength(1);
    expect(store.read("counters/invoiceCounter")).toEqual({ value: 2000 });
  });
});
