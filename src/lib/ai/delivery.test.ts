import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";

vi.mock("firebase/firestore", async () => (await import("@/test/fakeFirestore")).clientModule);
vi.mock("@/lib/firebase", () => ({ db: {}, firebaseApp: {} }));

import { store, adminFacade } from "@/test/fakeFirestore";
import { __setAdminDbForTests } from "@/lib/server/firebaseAdmin";
import { executeTool, type ToolContext } from "@/lib/ai/tools";
import { getInvoice } from "@/lib/server/businessStore";
import { isOpenDelivery, type Invoice } from "@/lib/types";

let opCounter = 0;
const op = () => `op-${++opCounter}`;
type R = Record<string, unknown> & { status: string; invoice?: Invoice };
const run = (name: string, args: Record<string, unknown>, ctx: ToolContext = {}) =>
  executeTool(name, args, { operationId: op(), ...ctx }) as Promise<R>;

beforeEach(() => {
  store.reset();
  __setAdminDbForTests(adminFacade() as unknown as Firestore);
  store.put("customers/c1", { name: "Hoa Lee", aliases: [], active: true, defaultShipping: 0, createdAt: 1, updatedAt: 1 });
  store.put("customers/c2", { name: "Anh Tuấn", aliases: [], active: true, defaultShipping: 0, createdAt: 1, updatedAt: 1 });
  store.put("products/p1", { name: "Milo", aliases: [], defaultUnit: "thùng", defaultPrice: 29, quantity: 100, active: true, createdAt: 1, updatedAt: 1 });
  store.put("products/p2", { name: "Bột giặt", aliases: [], defaultUnit: "bao", defaultPrice: 10, active: true, createdAt: 1, updatedAt: 1 });
});

const deliver = (items: Record<string, unknown>[], ctx: ToolContext = {}, extra: Record<string, unknown> = {}) =>
  run("createDeliveryOrder", { customerName: "Hoa Lee", items, ...extra }, ctx);

describe("createDeliveryOrder", () => {
  it("saves an unpaid invoice tagged Delivery, with $0 for items that have no price (not incomplete)", async () => {
    const res = await deliver([
      { productName: "milo", quantity: 5 },
      { productName: "bot giat", quantity: 2, price: 9 },
    ]);
    expect(res.status).toBe("created");
    const inv = res.invoice!;
    expect(inv.delivery).toEqual({ status: "open" });
    expect(inv.paymentStatus).toBe("unpaid");
    expect(inv.items.map((i) => [i.productName, i.quantity, i.price, i.lineTotal])).toEqual([
      ["Milo", 5, 0, 0],
      ["Bột giặt", 2, 9, 18],
    ]);
    expect(inv.items.some((i) => i.incomplete)).toBe(false);
    expect(inv.total).toBe(18);
    expect(inv.balance).toBe(18);
    expect(res.unpricedItems).toEqual(["Milo"]);
    // Goods left the shop: tracked stock is taken just like for any committed invoice.
    expect(store.read("products/p1")?.quantity).toBe(95);
  });

  it("never fills in last/default prices for a delivery", async () => {
    await run("createInvoiceDraft", { customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: 1, price: 31 }] });
    const res = await deliver([{ productName: "Milo", quantity: 3 }]);
    expect(res.invoice!.items[0].price).toBe(0);
  });

  it("asks for a missing quantity instead of saving anything", async () => {
    const before = store.count("invoices");
    const res = await deliver([{ productName: "Milo" }]);
    expect(res.status).toBe("needs_more_info");
    expect(res.missingQuantity).toEqual(["Milo"]);
    expect(store.count("invoices")).toBe(before);
  });

  it("from Telegram: shows a preview with yes/edit buttons and saves only after she confirms", async () => {
    const items = [{ productName: "milo", quantity: 5 }];
    const preview = await deliver(items, { channel: "telegram" });
    expect(preview.status).toBe("needs_confirmation");
    expect(preview.confirmChoices).toEqual(["Đúng, lưu đơn giao", "Sửa lại"]);
    expect(preview.preview).toMatchObject({ customer: { name: "Hoa Lee" }, items: [{ productName: "Milo", quantity: 5, price: 0 }] });
    expect(store.count("invoices")).toBe(0);

    // confirmed=true is ignored unless this job really is her answer to the question
    const notAnswer = await deliver(items, { channel: "telegram" }, { confirmed: true });
    expect(notAnswer.status).toBe("needs_confirmation");
    expect(store.count("invoices")).toBe(0);

    const saved = await deliver(items, { channel: "telegram", canConfirm: true }, { confirmed: true });
    expect(saved.status).toBe("created");
    expect(store.count("invoices")).toBe(1);
  });

  it("in the app, saves straight away (no extra confirmation step)", async () => {
    expect((await deliver([{ productName: "Milo", quantity: 1 }], { channel: "app" })).status).toBe("created");
  });
});

describe("getDeliveries", () => {
  it("counts a customer's open deliveries and totals the quantities per product", async () => {
    await deliver([{ productName: "Milo", quantity: 5 }]);
    await deliver([{ productName: "Milo", quantity: 3 }, { productName: "Bột giặt", quantity: 1 }]);
    await run("createDeliveryOrder", { customerName: "Anh Tuấn", items: [{ productName: "Milo", quantity: 7 }] });
    await run("createInvoiceDraft", { customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: 1, price: 29 }] });

    const res = await run("getDeliveries", { customerName: "hoa lee" });
    expect(res.count).toBe(2);
    expect(res.quantityByProduct).toEqual(
      expect.arrayContaining([
        { productName: "Milo", unit: "thùng", quantity: 8 },
        { productName: "Bột giặt", unit: "bao", quantity: 1 },
      ])
    );
    expect((res.deliveries as { unpricedItems: string[] }[])[0].unpricedItems.length).toBeGreaterThan(0);

    const all = await run("getDeliveries", {});
    expect(all.count).toBe(3);
  });

  it("a voided or converted delivery is no longer open", async () => {
    const a = await deliver([{ productName: "Milo", quantity: 1 }]);
    const b = await deliver([{ productName: "Milo", quantity: 2 }]);
    await run("updateInvoice", { invoiceId: a.invoice!.id, status: "void", reason: "wrong order" });
    await run("convertDelivery", { invoiceId: b.invoice!.id, prices: [{ productName: "Milo", price: 30 }], reason: "priced" });
    expect((await run("getDeliveries", { customerId: "c1" })).count).toBe(0);
    expect((await run("getDeliveries", { customerId: "c1", status: "converted" })).count).toBe(1);
  });
});

describe("convertDelivery", () => {
  it("sets the final prices, keeps the number and unpaid status, and logs it", async () => {
    const d = (await deliver([{ productName: "Milo", quantity: 5 }, { productName: "Bột giặt", quantity: 2, price: 9 }])).invoice!;
    const res = await run("convertDelivery", { invoiceNumber: d.invoiceNumber, prices: [{ productName: "milo", price: 30 }], reason: "chốt giá" });
    expect(res.status).toBe("converted");
    const after = (await getInvoice(d.id))!;
    expect(after.invoiceNumber).toBe(d.invoiceNumber);
    expect(after.items.map((i) => i.price)).toEqual([30, 9]);
    expect(after.total).toBe(168);
    expect(after.balance).toBe(168);
    expect(after.paymentStatus).toBe("unpaid");
    expect(after.delivery?.status).toBe("converted");
    expect(isOpenDelivery(after)).toBe(false);
    // stock was taken once at delivery and is not taken again by pricing it
    expect(store.read("products/p1")?.quantity).toBe(95);
    const logs = store.list("invoiceLogs").filter(([, l]) => l.invoiceId === d.id);
    expect(logs.some(([, l]) => l.message === "chốt giá")).toBe(true);
  });

  it("refuses while a $0 item has no price, and changes nothing", async () => {
    const d = (await deliver([{ productName: "Milo", quantity: 5 }, { productName: "Bột giặt", quantity: 2 }])).invoice!;
    const res = await run("convertDelivery", { invoiceId: d.id, prices: [{ productName: "Milo", price: 30 }], reason: "x" });
    expect(res.status).toBe("error");
    expect(String(res.message)).toContain("Bột giặt");
    const after = (await getInvoice(d.id))!;
    expect(after.delivery?.status).toBe("open");
    expect(after.total).toBe(0);
  });

  it("accepts an explicit $0 (free item)", async () => {
    const d = (await deliver([{ productName: "Milo", quantity: 5 }, { productName: "Bột giặt", quantity: 1 }])).invoice!;
    const res = await run("convertDelivery", { invoiceId: d.id, prices: [{ productName: "Milo", price: 30 }, { productName: "Bột giặt", price: 0 }], reason: "tặng" });
    expect(res.status).toBe("converted");
    expect(res.invoice!.total).toBe(150);
  });

  it("can't convert twice, or convert a normal invoice", async () => {
    const d = (await deliver([{ productName: "Milo", quantity: 1 }])).invoice!;
    await run("convertDelivery", { invoiceId: d.id, prices: [{ productName: "Milo", price: 30 }], reason: "a" });
    const again = await run("convertDelivery", { invoiceId: d.id, prices: [{ productName: "Milo", price: 99 }], reason: "b" });
    expect(again.status).toBe("error");
    expect((await getInvoice(d.id))!.items[0].price).toBe(30);

    const normal = (await run("createInvoiceDraft", { customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: 1, price: 29 }] })).invoice!;
    expect((await run("convertDelivery", { invoiceId: normal.id, prices: [], reason: "c" })).status).toBe("error");
  });

  it("rejects a negative price", async () => {
    const d = (await deliver([{ productName: "Milo", quantity: 1 }])).invoice!;
    expect((await run("convertDelivery", { invoiceId: d.id, prices: [{ productName: "Milo", price: -5 }], reason: "x" })).status).toBe("needs_more_info");
  });
});

describe("deliveries don't disturb normal invoicing", () => {
  it("an open delivery's $0 lines are never used as the customer's 'last price'", async () => {
    await run("createInvoiceDraft", { customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: 1, price: 31 }] });
    await deliver([{ productName: "Milo", quantity: 4 }]);
    expect(await run("getLastPrice", { customerId: "c1", productId: "p1" })).toEqual({ price: 31 });
    const draft = await run("createInvoiceDraft", { customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: 2 }] });
    expect(draft.invoice!.items[0].price).toBe(31);
  });

  it("adding an item with no price: $0 on an open delivery, still asked on a normal invoice", async () => {
    store.put("products/p3", { name: "Kẹo", aliases: [], defaultUnit: "gói", defaultPrice: 0, active: true, createdAt: 1, updatedAt: 1 });
    const d = (await deliver([{ productName: "Milo", quantity: 1 }])).invoice!;
    const added = await run("addInvoiceItem", { invoiceId: d.id, productName: "Bột giặt", quantity: 3, reason: "thêm" });
    expect(added.status).toBe("updated");
    expect(added.invoice!.items.find((i) => i.productName === "Bột giặt")?.price).toBe(0);

    const normal = (await run("createInvoiceDraft", { customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: 1, price: 29 }] })).invoice!;
    expect((await run("addInvoiceItem", { invoiceId: normal.id, productName: "Kẹo", quantity: 1, reason: "x" })).status).toBe("needs_more_info");
  });
});
