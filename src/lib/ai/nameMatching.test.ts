import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";

vi.mock("firebase/firestore", async () => (await import("@/test/fakeFirestore")).clientModule);
vi.mock("@/lib/firebase", () => ({ db: {}, firebaseApp: {} }));

import { store, adminFacade } from "@/test/fakeFirestore";
import { __setAdminDbForTests } from "@/lib/server/firebaseAdmin";
import { executeTool } from "@/lib/ai/tools";
import { similarity, wordMatchScore } from "@/lib/similarity";
import type { Invoice } from "@/lib/types";

type Result = {
  status: string;
  invoice?: Invoice;
  priceWarnings?: string[];
  incompleteItems?: string[];
  candidates?: Array<{ id: string; name: string }>;
  results?: Array<{ id: string; name: string }>;
};

let opCounter = 0;
const draft = (args: Record<string, unknown>) =>
  executeTool("createInvoiceDraft", args, { operationId: `op-${++opCounter}` }) as Promise<Result>;

// A small grocery catalog with long, real-looking names and deliberate near-duplicates.
const PRODUCTS: Array<[string, string, string, number]> = [
  ["coca", "Coca Cola lon 12oz thùng 24", "thùng", 12.5],
  ["pepsi", "Pepsi lon 12oz thùng 24", "thùng", 12],
  ["khongdo", "Trà xanh Không Độ chai 455ml thùng 24", "thùng", 15.5],
  ["milo_hop", "Milo 3in1 hộp 18 gói", "hộp", 7.5],
  ["milo_lon", "Milo lon 240ml thùng 24", "thùng", 14],
  ["gao_jas", "Gạo Jasmine 25lb", "bao", 20],
  ["gao_st25", "Gạo ST25 10lb", "bao", 15],
  ["cotdua", "Nước cốt dừa Chaokoh 13.5oz", "lon", 1.4],
];
const CUSTOMERS: Array<[string, string]> = [
  ["c_hoa", "Chị Hoa"],
  ["c_hoa2", "Chị Hòa"],
  ["c_lan", "Cô Lan"],
  ["c_lanh", "Cô Lành"],
  ["c_nam", "Bà Năm"],
];

beforeEach(() => {
  store.reset();
  __setAdminDbForTests(adminFacade() as unknown as Firestore);
  const now = 1_760_000_000_000;
  for (const [id, name, unit, price] of PRODUCTS) {
    store.put(`products/${id}`, { name, aliases: [], defaultUnit: unit, defaultPrice: price, active: true, createdAt: now, updatedAt: now });
  }
  for (const [id, name] of CUSTOMERS) {
    store.put(`customers/${id}`, { name, aliases: [], phone: "", address: "", active: true, defaultShipping: 0, createdAt: now, updatedAt: now });
  }
  store.put("counters/invoices", { value: 1000 });
});

describe("word matching in similarity", () => {
  it("a short brand name scores well against a long catalog name", () => {
    expect(similarity("coca", "Coca Cola lon 12oz thùng 24")).toBeGreaterThanOrEqual(0.75);
    expect(similarity("khong do", "Trà xanh Không Độ chai 455ml thùng 24")).toBeGreaterThanOrEqual(0.75);
  });

  it("every typed word must be there", () => {
    expect(wordMatchScore("coca zero", "Coca Cola lon 12oz thùng 24")).toBe(0);
    // two-letter words must match whole words, not just the start of one
    expect(wordMatchScore("mi", "Milo lon 240ml")).toBe(0);
  });
});

describe("product matching", () => {
  it("finds a product from its brand word alone", async () => {
    for (const [query, id] of [["coca", "coca"], ["pepsi", "pepsi"], ["khong do", "khongdo"], ["milo lon", "milo_lon"]]) {
      const r = await draft({ customerId: "c_nam", items: [{ productName: query, quantity: 1, price: 1 }] });
      expect(r.status, query).toBe("created");
      expect(r.invoice!.items[0].productId, query).toBe(id);
    }
  });

  it("searchProduct lists the long name for a short brand word", async () => {
    const r = (await executeTool("searchProduct", { query: "pepsi" })) as Result;
    expect(r.results?.[0]?.id).toBe("pepsi");
  });

  it("asks instead of guessing when two products match equally", async () => {
    for (const query of ["milo", "gao"]) {
      const r = await draft({ customerId: "c_nam", items: [{ productName: query, quantity: 1, price: 1 }] });
      expect(r.status, query).toBe("needs_confirmation");
      expect(r.candidates!.length, query).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("customer matching never picks one of two look-alike names on its own", () => {
  it("an unaccented name that fits two customers is asked", async () => {
    const r = await draft({ customerName: "chi hoa", items: [{ productId: "coca", quantity: 1, price: 1 }] });
    expect(r.status).toBe("needs_confirmation");
    expect(r.candidates!.map((c) => c.id).sort()).toEqual(["c_hoa", "c_hoa2"]);
  });

  it("the exact accented name picks that customer", async () => {
    const hoa2 = await draft({ customerName: "Chị Hòa", items: [{ productId: "coca", quantity: 1, price: 1 }] });
    expect(hoa2.invoice?.customerId).toBe("c_hoa2");
    const hoa = await draft({ customerName: "Chị Hoa", items: [{ productId: "coca", quantity: 1, price: 1 }] });
    expect(hoa.invoice?.customerId).toBe("c_hoa");
  });

  it("an exact unaccented name still wins over a name that only starts the same way", async () => {
    const r = await draft({ customerName: "co lan", items: [{ productId: "coca", quantity: 1, price: 1 }] });
    expect(r.invoice?.customerId).toBe("c_lan");
  });
});

describe("unit check", () => {
  it("a different unit than the product's is not priced at the per-unit price", async () => {
    const r = await draft({ customerId: "c_nam", items: [{ productId: "cotdua", quantity: 2, unit: "thùng" }] });
    expect(r.status).toBe("created");
    const line = r.invoice!.items[0];
    expect(line.price).toBe(0);
    expect(line.incomplete).toBe(true);
    expect(line.unit).toBe("thùng");
    expect(r.incompleteItems).toEqual(["Nước cốt dừa Chaokoh 13.5oz"]);
    expect(r.priceWarnings!.join(" ")).toContain("thùng");
  });

  it("the same unit, with or without accents, still uses the catalog price", async () => {
    const r = await draft({ customerId: "c_nam", items: [{ productId: "coca", quantity: 2, unit: "thung" }] });
    expect(r.invoice!.items[0].price).toBe(12.5);
    expect(r.invoice!.items[0].incomplete).toBe(false);
  });

  it("a price she states for her unit is used as given", async () => {
    const r = await draft({ customerId: "c_nam", items: [{ productId: "cotdua", quantity: 2, unit: "thùng", price: 30 }] });
    expect(r.invoice!.items[0].price).toBe(30);
    expect(r.invoice!.items[0].lineTotal).toBe(60);
    expect(r.invoice!.items[0].incomplete).toBe(false);
  });

  it("the customer's last price is only reused for the unit it was charged in", async () => {
    const first = await draft({ customerId: "c_nam", items: [{ productId: "cotdua", quantity: 24, unit: "lon", price: 1.3 }] });
    expect(first.status).toBe("created");
    const again = await draft({ customerId: "c_nam", items: [{ productId: "cotdua", quantity: 24, unit: "lon" }] });
    expect(again.invoice!.items[0].price).toBe(1.3);
    const byCase = await draft({ customerId: "c_nam", items: [{ productId: "cotdua", quantity: 1, unit: "thùng" }] });
    expect(byCase.invoice!.items[0].price).toBe(0);
    expect(byCase.invoice!.items[0].incomplete).toBe(true);
  });
});
