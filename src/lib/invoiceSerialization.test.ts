import { afterAll, beforeEach, expect, it, vi } from "vitest";
import type { DocumentData } from "firebase/firestore";
import type { Firestore } from "firebase-admin/firestore";

// Keep storage in memory, but validate EVERY transaction payload with the real
// SDK's public WriteBatch API. Never commit the batch or contact a database.
vi.mock("firebase/firestore", async () => {
  const sdk = await vi.importActual<typeof import("firebase/firestore")>("firebase/firestore");
  const { initializeApp } = await import("firebase/app");
  const { clientModule } = await import("@/test/fakeFirestore");
  const db = sdk.getFirestore(initializeApp({ projectId: "demo-invoice-validation" }, "invoice-validation"));
  afterAll(() => sdk.terminate(db));
  type Ref = { path: string };
  type Tx = {
    get: (ref: Ref) => Promise<unknown>;
    set: (ref: Ref, data: DocumentData, opts?: { merge?: boolean }) => void;
    update: (ref: Ref, data: DocumentData) => void;
  };
  return {
    ...clientModule,
    runTransaction: <T>(fakeDb: unknown, fn: (tx: Tx) => Promise<T>) =>
      clientModule.runTransaction(fakeDb, async (raw) => {
        const tx = raw as Tx;
        return fn({
          get: tx.get,
          set: (ref, data, opts) => {
            sdk.writeBatch(db).set(sdk.doc(db, ref.path), data, { merge: opts?.merge ?? false });
            tx.set(ref, data, opts);
          },
          update: (ref, data) => {
            sdk.writeBatch(db).update(sdk.doc(db, ref.path), data);
            tx.update(ref, data);
          },
        });
      }),
  };
});
vi.mock("@/lib/firebase", () => ({ db: {}, firebaseApp: {} }));

import { store, adminFacade } from "@/test/fakeFirestore";
import { __setAdminDbForTests } from "@/lib/server/firebaseAdmin";
import { executeTool } from "@/lib/ai/tools";
import { copyInvoice, createInvoice, updateInvoiceWithLog } from "@/lib/store";
import type { Invoice, InvoiceLineItem } from "@/lib/types";

const line = (barcode?: string): InvoiceLineItem => ({
  productName: "Milo", quantity: 2, unit: "box", price: 12.5, lineTotal: 25,
  productId: undefined, barcode, incomplete: false,
});
beforeEach(() => {
  store.reset();
  // executeTool (below) runs tools.ts, which is Admin-SDK-backed (src/lib/server/businessStore.ts) since Task B;
  // the OTHER two tests in this file exercise src/lib/store.ts (the client-SDK path) directly and are unaffected.
  __setAdminDbForTests(adminFacade() as unknown as Firestore);
});

it("the real SDK validation rejects undefined fields in invoice and audit payloads", async () => {
  const sdk = await vi.importActual<typeof import("firebase/firestore")>("firebase/firestore");
  const { initializeApp, deleteApp } = await import("firebase/app");
  const app = initializeApp({ projectId: "demo-invoice-validation" }, "validation-control");
  const db = sdk.getFirestore(app);
  try {
    for (const data of [{ items: [line()] }, { after: { items: [line()] } }]) {
      expect(() => sdk.writeBatch(db).set(sdk.doc(db, "probe/control"), data)).toThrow(/undefined/);
    }
  } finally {
    await sdk.terminate(db);
    await deleteApp(app);
  }
});

it("AI creation handles mixed barcode products and retries exactly once", async () => {
  store.put("customers/c1", { name: "Test customer", aliases: [], active: true });
  store.put("products/p1", { name: "Milo", aliases: [], defaultPrice: 12.5, defaultUnit: "box" });
  store.put("products/p2", { name: "Tea", aliases: [], defaultPrice: 5, defaultUnit: "box", barcode: "001234" });
  const args = { customerId: "c1", items: [{ productId: "p1", quantity: 2 }, { productId: "p2", quantity: 3 }], shipping: 4, discount: 1 };
  const first = await executeTool("createInvoiceDraft", args, { operationId: "draft-once" }) as { invoice: Invoice };
  const retry = await executeTool("createInvoiceDraft", args, { operationId: "draft-once" }) as { invoice: Invoice };
  expect(retry.invoice).toEqual(first.invoice);
  expect(first.invoice).toMatchObject({ invoiceNumber: "2000", subtotal: 40, total: 43, balance: 43 });
  expect(first.invoice.items[0]).not.toHaveProperty("barcode");
  expect(first.invoice.items[1].barcode).toBe("001234");
  expect(store.count("invoices")).toBe(1);
  expect(store.count("invoiceLogs")).toBe(1);
  expect(store.read("counters/invoiceCounter")).toEqual({ value: 2000 });
});

it("manual create, edits, audit snapshots and copy omit absent optional fields without mutating inputs", async () => {
  const items = [line(), line("001234")];
  const original = await createInvoice({ customerName: "Test", items, actor: "user", createdBy: "user" });
  expect(items[0]).toHaveProperty("barcode", undefined);
  expect(original.items[0]).not.toHaveProperty("productId");
  expect(original.items[0].incomplete).toBe(false);
  const updated = await updateInvoiceWithLog({ invoiceId: original.id, items: [line(), line("")], actor: "user", reason: "Edit" });
  expect(updated.items[1].barcode).toBe("");
  await updateInvoiceWithLog({ invoiceId: original.id, items: (before) => before.items.map((item) => ({ ...item, barcode: undefined })), actor: "ai", reason: "Clear barcode" });
  const copied = await copyInvoice({ sourceInvoiceId: original.id, actor: "ai", operationId: "copy-once" });
  const replay = await copyInvoice({ sourceInvoiceId: original.id, actor: "ai", operationId: "copy-once" });
  expect(replay).toEqual(copied);
  expect(copied.total).toBe(50);
  expect(copied.items.every((item) => !("barcode" in item))).toBe(true);
  expect(store.count("invoices")).toBe(2);
  expect(store.count("invoiceLogs")).toBe(4);
});
