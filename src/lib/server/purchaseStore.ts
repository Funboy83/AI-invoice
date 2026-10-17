import type { DocumentReference, Firestore } from "firebase-admin/firestore";
import { getAdminDb } from "./firebaseAdmin";
import { runOnce } from "./businessStore";
import { DomainError, NotFoundError, ValidationError } from "@/lib/domainErrors";
import { assertNonNegativeAmount, assertPositiveAmount, MAX_FINANCIAL_VALUE } from "@/lib/invoiceMath";
import type { Purchase, PurchaseLine, PurchaseStatus, Vendor, VendorPayment } from "@/lib/types";

/**
 * Buying from vendors: vendors, purchases (purchase orders) and payments to vendors. Server-only (Admin SDK), the
 * same way businessStore.ts handles the selling side, and it never reads or writes invoices, customers or customer
 * payments. The only existing data it touches is a product's `quantity` (stock) and, when asked, its `cost`.
 *
 * Every money/stock write runs in ONE Firestore transaction with the idempotency ledger (runOnce), so a retried
 * "Save" can never add stock twice or record a payment twice.
 */

const db = (): Firestore => getAdminDb();
const vendorsCol = () => db().collection("vendors");
const purchasesCol = () => db().collection("purchases");
const vendorPaymentsCol = () => db().collection("vendorPayments");
const productsCol = () => db().collection("products");
const countersCol = () => db().collection("counters");

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Vendor invoice numbers are compared ignoring case and spaces, so "inv 123" and "INV123" are the same number. */
export const normalizeVendorInvoiceNumber = (s: string) => s.replace(/\s+/g, "").toLowerCase();

function computeStatus(total: number, amountPaid: number): PurchaseStatus {
  if (amountPaid <= 0) return total <= 0 ? "paid" : "unpaid";
  if (amountPaid >= total) return "paid";
  return "partial";
}

/* --------------------------------- Vendors --------------------------------- */

function hydrateVendor(id: string, d: Record<string, unknown>): Vendor {
  return {
    id,
    name: d.name as string,
    contactName: (d.contactName as string) || undefined,
    phone: (d.phone as string) || undefined,
    email: (d.email as string) || undefined,
    address: (d.address as string) || undefined,
    notes: (d.notes as string) || undefined,
    active: (d.active as boolean) ?? true,
    createdAt: (d.createdAt as number) ?? 0,
    updatedAt: (d.updatedAt as number) ?? 0,
  };
}

export async function getAllVendors(): Promise<Vendor[]> {
  const snap = await vendorsCol().orderBy("name").get();
  return snap.docs.map((d) => hydrateVendor(d.id, d.data()));
}

export async function getVendor(id: string): Promise<Vendor | null> {
  const snap = await vendorsCol().doc(id).get();
  return snap.exists ? hydrateVendor(snap.id, snap.data()!) : null;
}

type VendorFields = Pick<Vendor, "name"> & Partial<Pick<Vendor, "contactName" | "phone" | "email" | "address" | "notes">>;

export async function createVendor(input: VendorFields & { operationId?: string }): Promise<Vendor> {
  const now = Date.now();
  const payload = {
    name: input.name,
    contactName: input.contactName ?? "",
    phone: input.phone ?? "",
    email: input.email ?? "",
    address: input.address ?? "",
    notes: input.notes ?? "",
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  return runOnce(input.operationId, "createVendor", { ...input, operationId: undefined }, async (tx) => {
    const ref = vendorsCol().doc();
    tx.set(ref, payload);
    return hydrateVendor(ref.id, payload);
  });
}

export async function updateVendor(id: string, changes: Partial<VendorFields & { active: boolean }>, operationId?: string): Promise<void> {
  await runOnce(operationId, "updateVendor", { id, changes }, async (tx) => {
    const ref = vendorsCol().doc(id);
    if (!(await tx.get(ref)).exists) throw new NotFoundError("Vendor not found.");
    // Purchases keep the vendor name they were saved with (like invoices keep the customer name).
    tx.update(ref, { ...changes, updatedAt: Date.now() });
    return null;
  });
}

/* -------------------------------- Purchases -------------------------------- */

function hydratePurchase(id: string, d: Record<string, unknown>): Purchase {
  return {
    id,
    purchaseNumber: d.purchaseNumber as string,
    vendorId: d.vendorId as string,
    vendorName: d.vendorName as string,
    vendorInvoiceNumber: (d.vendorInvoiceNumber as string) ?? "",
    dateKey: d.dateKey as string,
    items: (d.items as PurchaseLine[]) ?? [],
    shipping: (d.shipping as number) ?? 0,
    discount: (d.discount as number) ?? 0,
    subtotal: d.subtotal as number,
    total: d.total as number,
    amountPaid: (d.amountPaid as number) ?? 0,
    balance: d.balance as number,
    paymentStatus: d.paymentStatus as PurchaseStatus,
    notes: (d.notes as string) ?? "",
    updatedCost: (d.updatedCost as boolean) ?? false,
    addedQuantities: (d.addedQuantities as { productId: string; quantity: number }[]) ?? [],
    createdAt: (d.createdAt as number) ?? 0,
    updatedAt: (d.updatedAt as number) ?? 0,
    ...(d.voidedAt ? { voidedAt: d.voidedAt as number } : {}),
  };
}

export async function getAllPurchases(): Promise<Purchase[]> {
  const snap = await purchasesCol().orderBy("createdAt", "desc").get();
  return snap.docs.map((d) => hydratePurchase(d.id, d.data()));
}

export async function getPurchase(id: string): Promise<Purchase | null> {
  const snap = await purchasesCol().doc(id).get();
  return snap.exists ? hydratePurchase(snap.id, snap.data()!) : null;
}

/** All purchases from one vendor, newest first. Single-field filter, so no extra Firestore index is needed. */
export async function getPurchasesForVendor(vendorId: string): Promise<Purchase[]> {
  const snap = await purchasesCol().where("vendorId", "==", vendorId).get();
  return snap.docs.map((d) => hydratePurchase(d.id, d.data())).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getPaymentsForPurchase(purchaseId: string): Promise<VendorPayment[]> {
  const snap = await vendorPaymentsCol().where("purchaseId", "==", purchaseId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as VendorPayment).sort((a, b) => b.createdAt - a.createdAt);
}

/** The other (not cancelled) purchase from this vendor that already uses this vendor invoice number, if any. */
export async function findVendorInvoiceClash(vendorId: string, vendorInvoiceNumber: string, exceptPurchaseId?: string): Promise<Purchase | null> {
  const wanted = normalizeVendorInvoiceNumber(vendorInvoiceNumber);
  if (!wanted) return null;
  const snap = await purchasesCol().where("vendorId", "==", vendorId).get();
  return (
    snap.docs
      .map((d) => hydratePurchase(d.id, d.data()))
      .find((p) => p.id !== exceptPurchaseId && p.paymentStatus !== "void" && normalizeVendorInvoiceNumber(p.vendorInvoiceNumber) === wanted) ?? null
  );
}

/**
 * Refuses a vendor invoice number already used on another (not cancelled) purchase from the same vendor, so the
 * same bill can't be entered twice by accident. Runs as a plain read inside the transaction body, which only runs
 * for a NEW operation: a retry of the same Save replays its saved result instead of tripping over itself.
 */
async function assertVendorInvoiceNumberFree(vendorId: string, vendorInvoiceNumber: string, exceptPurchaseId?: string): Promise<void> {
  const clash = await findVendorInvoiceClash(vendorId, vendorInvoiceNumber, exceptPurchaseId);
  if (clash) {
    throw new DomainError(`Vendor invoice #${vendorInvoiceNumber} from this vendor is already saved as ${clash.purchaseNumber}.`);
  }
}

export interface PurchaseLineInput {
  productId: string;
  quantity: number;
  cost: number;
  unit?: string;
}

export interface CreatePurchaseInput {
  vendorId: string;
  vendorInvoiceNumber?: string;
  dateKey: string;
  items: PurchaseLineInput[];
  shipping?: number;
  discount?: number;
  notes?: string;
  /** Also set each product's cost to the price paid on this purchase. */
  updateCost: boolean;
  /** Paid to the vendor right away (0 or omitted = nothing paid yet). Never more than the total. */
  paidNow?: number;
  payMethod?: string;
  operationId?: string;
}

/**
 * Saves a purchase and, in the SAME transaction: adds each product's quantity to its stock, optionally updates its
 * cost, and records the payment made right away (if any). A product whose stock wasn't tracked yet starts being
 * tracked at the bought quantity, so from then on invoices count it down as usual.
 */
export async function createPurchase(input: CreatePurchaseInput): Promise<{ purchase: Purchase; stockNotes: string[] }> {
  if (!input.items.length) throw new ValidationError("Add at least one product.");
  if (input.items.length > 200) throw new ValidationError("Too many lines on one purchase.");
  for (const it of input.items) {
    assertPositiveAmount(it.quantity, "Quantity");
    assertNonNegativeAmount(it.cost, "Cost");
  }
  const shipping = input.shipping ?? 0;
  const discount = input.discount ?? 0;
  assertNonNegativeAmount(shipping, "Shipping / fees");
  assertNonNegativeAmount(discount, "Discount");
  const paidNow = input.paidNow ?? 0;
  assertNonNegativeAmount(paidNow, "Amount paid");
  const vendorInvoiceNumber = (input.vendorInvoiceNumber ?? "").trim();

  const vendorRef = vendorsCol().doc(input.vendorId);
  const counterRef = countersCol().doc("purchaseCounter");
  const purchaseRef = purchasesCol().doc();
  const paymentRef = vendorPaymentsCol().doc();

  const fingerprint = { ...input, operationId: undefined };
  return runOnce(input.operationId, "createPurchase", fingerprint, async (tx) => {
    await assertVendorInvoiceNumberFree(input.vendorId, vendorInvoiceNumber);

    // All transaction reads first (Firestore requires every read before any write).
    const vendorSnap = await tx.get(vendorRef);
    if (!vendorSnap.exists) throw new NotFoundError("Vendor not found.");
    const vendor = hydrateVendor(vendorSnap.id, vendorSnap.data()!);
    const counterSnap = await tx.get(counterRef);
    const productIds = [...new Set(input.items.map((i) => i.productId))];
    const productSnaps = await Promise.all(productIds.map((id) => tx.get(productsCol().doc(id))));
    const products = new Map<string, { ref: DocumentReference; name: string; unit: string; quantity: number | null }>();
    productSnaps.forEach((snap, i) => {
      if (!snap.exists) throw new NotFoundError("A product on this purchase no longer exists. Pick it again.");
      const d = snap.data()!;
      products.set(productIds[i], { ref: snap.ref, name: d.name as string, unit: (d.defaultUnit as string) || "unit", quantity: (d.quantity as number | null | undefined) ?? null });
    });

    // Money: line totals and the purchase total are always computed here, never taken from the browser.
    const items: PurchaseLine[] = input.items.map((it) => {
      const p = products.get(it.productId)!;
      return { productId: it.productId, productName: p.name, quantity: it.quantity, unit: it.unit?.trim() || p.unit, cost: it.cost, lineTotal: r2(it.quantity * it.cost) };
    });
    const subtotal = r2(items.reduce((s, l) => s + l.lineTotal, 0));
    const total = r2(subtotal + shipping - discount);
    if (!Number.isFinite(total) || total < 0 || total > MAX_FINANCIAL_VALUE) throw new ValidationError("The discount can't be more than the purchase total.");
    if (paidNow > total + 0.001) throw new ValidationError(`Amount paid ($${paidNow.toFixed(2)}) is more than the purchase total ($${total.toFixed(2)}).`);
    const amountPaid = r2(paidNow);
    const balance = r2(total - amountPaid);
    const paymentStatus = computeStatus(total, amountPaid);

    // Stock: add what was bought. Cost: the last line's cost for each product, when asked.
    const added = new Map<string, number>();
    const lastCost = new Map<string, number>();
    for (const l of items) {
      added.set(l.productId, (added.get(l.productId) ?? 0) + l.quantity);
      lastCost.set(l.productId, l.cost);
    }
    const now = Date.now();
    const stockNotes: string[] = [];
    const addedQuantities: { productId: string; quantity: number }[] = [];
    for (const [productId, qty] of added) {
      const p = products.get(productId)!;
      const newQty = (p.quantity ?? 0) + qty;
      if (p.quantity === null) stockNotes.push(`${p.name}: stock counting started at ${newQty}.`);
      addedQuantities.push({ productId, quantity: qty });
      tx.update(p.ref, { quantity: newQty, ...(input.updateCost ? { cost: lastCost.get(productId)! } : {}), updatedAt: now });
    }

    const current = counterSnap.exists ? (counterSnap.data() as { value: number }).value : 1000;
    const purchaseNumber = `PO-${current + 1}`;
    tx.set(counterRef, { value: current + 1 }, { merge: true });

    const payload = {
      purchaseNumber,
      vendorId: input.vendorId,
      vendorName: vendor.name,
      vendorInvoiceNumber,
      dateKey: input.dateKey,
      items,
      shipping,
      discount,
      subtotal,
      total,
      amountPaid,
      balance,
      paymentStatus,
      notes: input.notes ?? "",
      updatedCost: input.updateCost,
      addedQuantities,
      createdAt: now,
      updatedAt: now,
    };
    tx.set(purchaseRef, payload);
    if (amountPaid > 0) {
      tx.set(paymentRef, { purchaseId: purchaseRef.id, vendorId: input.vendorId, amount: amountPaid, method: input.payMethod ?? "", note: "Paid when the purchase was saved", createdAt: now });
    }
    return { purchase: hydratePurchase(purchaseRef.id, payload), stockNotes };
  });
}

/** Records money paid to the vendor for one purchase. Never more than what is still owed on it. */
export async function recordVendorPayment(input: { purchaseId: string; amount: number; method?: string; note?: string; operationId?: string }): Promise<Purchase> {
  assertPositiveAmount(input.amount, "Amount");
  const purchaseRef = purchasesCol().doc(input.purchaseId);
  const paymentRef = vendorPaymentsCol().doc();
  const fingerprint = { purchaseId: input.purchaseId, amount: input.amount, method: input.method, note: input.note };
  return runOnce(input.operationId, "recordVendorPayment", fingerprint, async (tx) => {
    const snap = await tx.get(purchaseRef);
    if (!snap.exists) throw new NotFoundError("Purchase not found.");
    const before = hydratePurchase(snap.id, snap.data()!);
    if (before.paymentStatus === "void") throw new DomainError("This purchase was cancelled.");
    if (input.amount > before.balance + 0.001) {
      throw new ValidationError(`That is more than what is still owed on ${before.purchaseNumber} ($${before.balance.toFixed(2)}).`);
    }
    const now = Date.now();
    const amountPaid = r2(before.amountPaid + input.amount);
    const balance = r2(before.total - amountPaid);
    const paymentStatus = computeStatus(before.total, amountPaid);
    tx.update(purchaseRef, { amountPaid, balance, paymentStatus, updatedAt: now });
    tx.set(paymentRef, { purchaseId: before.id, vendorId: before.vendorId, amount: input.amount, method: input.method ?? "", note: input.note ?? "", createdAt: now });
    return { ...before, amountPaid, balance, paymentStatus, updatedAt: now };
  });
}

/** Changes only the look-up details (vendor invoice number, date, notes) — never items, money or stock. */
export async function updatePurchaseInfo(
  id: string,
  changes: { vendorInvoiceNumber?: string; dateKey?: string; notes?: string },
  operationId?: string
): Promise<Purchase> {
  const ref = purchasesCol().doc(id);
  const vendorInvoiceNumber = changes.vendorInvoiceNumber?.trim();
  return runOnce(operationId, "updatePurchaseInfo", { id, changes }, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new NotFoundError("Purchase not found.");
    const before = hydratePurchase(snap.id, snap.data()!);
    if (vendorInvoiceNumber !== undefined) await assertVendorInvoiceNumberFree(before.vendorId, vendorInvoiceNumber, id);
    const fields: Record<string, unknown> = { updatedAt: Date.now() };
    if (vendorInvoiceNumber !== undefined) fields.vendorInvoiceNumber = vendorInvoiceNumber;
    if (changes.dateKey !== undefined) fields.dateKey = changes.dateKey;
    if (changes.notes !== undefined) fields.notes = changes.notes;
    tx.update(ref, fields);
    return { ...before, ...fields } as Purchase;
  });
}

/**
 * Cancels a purchase entered by mistake: takes exactly the quantities it added back out of stock, marks any
 * payments recorded on it as voided, and stops it counting toward what is owed to the vendor. The purchase itself
 * is kept (marked cancelled) for history. A product's cost is not changed back.
 */
export async function voidPurchase(id: string, operationId?: string): Promise<{ purchase: Purchase; stockWarnings: string[] }> {
  const ref = purchasesCol().doc(id);
  return runOnce(operationId, "voidPurchase", { id }, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new NotFoundError("Purchase not found.");
    const before = hydratePurchase(snap.id, snap.data()!);
    if (before.paymentStatus === "void") throw new DomainError("This purchase is already cancelled.");
    const productSnaps = await Promise.all(before.addedQuantities.map((a) => tx.get(productsCol().doc(a.productId))));
    const paymentDocs = (await vendorPaymentsCol().where("purchaseId", "==", id).get()).docs;

    const now = Date.now();
    const stockWarnings: string[] = [];
    before.addedQuantities.forEach((a, i) => {
      const ps = productSnaps[i];
      if (!ps.exists) return; // product deleted since — nothing to take back
      const d = ps.data()!;
      const qty = (d.quantity as number | null | undefined) ?? null;
      if (qty === null) return; // stock no longer tracked for it
      const newQty = qty - a.quantity;
      if (newQty < 0) stockWarnings.push(`${d.name as string}: stock is now ${newQty} (below zero).`);
      tx.update(ps.ref, { quantity: newQty, updatedAt: now });
    });
    for (const p of paymentDocs) if (!(p.data() as { voided?: boolean }).voided) tx.update(p.ref, { voided: true });
    tx.update(ref, { paymentStatus: "void", voidedAt: now, updatedAt: now });
    return { purchase: { ...before, paymentStatus: "void" as const, voidedAt: now, updatedAt: now }, stockWarnings };
  });
}
