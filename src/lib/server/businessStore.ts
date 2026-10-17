import { FieldPath, Timestamp, type DocumentReference, type Firestore, type Transaction } from "firebase-admin/firestore";
import { getAdminDb } from "./firebaseAdmin";
import { DomainError, NotFoundError, OperationConflictError, ValidationError } from "@/lib/domainErrors";
import { assertFiniteAmount, assertFiniteTotals, assertNonNegativeAmount, assertPositiveAmount, calcTotals, computePaymentStatus, invoiceItemsForWrite, sanitizeInvoiceItems } from "@/lib/invoiceMath";
import { allocatePaymentOldestFirst, type PaymentAllocation } from "@/lib/paymentAllocation";
import { isCommittedStatus, isOpenDelivery, type Customer, type CustomInvoiceDefaults, type InvoicePrintInfo, type PrintParty, type DeliveryInfo, type Invoice, type InvoiceLineItem, type InvoiceLog, type InvoiceStatus, type LogActor, type Payment, type Product } from "@/lib/types";

/**
 * Admin-SDK mirror of src/lib/store.ts: same collections, same transactions, same idempotency ledger, same totals
 * and Task A serialization (invoiceMath.ts is the shared source for the pure math on both sides) — but trusted
 * server-only access instead of the browser client SDK, so it works once Firestore rules require membership that
 * this process's service-account credentials are not subject to. Every exported name/signature here matches
 * store.ts's on purpose: src/lib/ai/tools.ts imports from here instead of from "@/lib/store" and needs no other
 * change. New server API routes (src/app/api/business/**) call these same functions for manual mutations, so
 * there is exactly one implementation of every business write, never two to keep in sync.
 */

export { DomainError, NotFoundError };

const db = (): Firestore => getAdminDb();
const productsCol = () => db().collection("products");
const customersCol = () => db().collection("customers");
const invoicesCol = () => db().collection("invoices");
const paymentsCol = () => db().collection("payments");
const logsCol = () => db().collection("invoiceLogs");
const countersCol = () => db().collection("counters");
const operationsCol = () => db().collection("operations");
const printInfoCol = () => db().collection("invoicePrintInfo");
const settingsCol = () => db().collection("settings");

/**
 * Runs `body` in a transaction idempotent per `operationId` (see store.ts's runOnce for the base contract — same
 * ledger collection, same "read the ledger, write the ledger" shape). `fingerprintInput` is whatever the CALLER
 * considers this operation's meaningful input (e.g. {customerId, items, shipping, discount} for createInvoice) —
 * it is stored alongside the cached result and checked on every replay. A stable retry key is only safe to reuse
 * when it is truly the SAME action being retried: if `operationId` is ever reused for a DIFFERENT tool or a
 * DIFFERENT fingerprint, this throws OperationConflictError instead of silently handing back the first call's
 * (unrelated) result — closing the gap a bare key-match ledger has no way to catch on its own.
 */
export async function runOnce<T>(operationId: string | undefined, tool: string, fingerprintInput: unknown, body: (tx: Transaction) => Promise<T>): Promise<T> {
  const fingerprint = JSON.stringify(fingerprintInput);
  return db().runTransaction(async (tx) => {
    if (!operationId) return body(tx);
    const opRef = operationsCol().doc(operationId);
    const opSnap = await tx.get(opRef);
    if (opSnap.exists) {
      const stored = opSnap.data() as { tool: string; fingerprint?: string; resultJson: string };
      if (stored.tool !== tool || stored.fingerprint !== fingerprint) {
        throw new OperationConflictError(`This action could not be confirmed as a retry of the same request (operationId ${operationId} was already used for something else) — please try again.`);
      }
      return JSON.parse(stored.resultJson) as T;
    }
    const result = await body(tx);
    tx.set(opRef, { operationId, tool, fingerprint, createdAt: Date.now(), resultJson: JSON.stringify(result) });
    return result;
  });
}

function toMillis(v: unknown): number {
  if (v instanceof Timestamp) return v.toMillis();
  if (typeof v === "number") return v;
  return Date.now();
}

/* --------------------------------- Products -------------------------------- */

function hydrateProduct(id: string, data: Record<string, unknown>): Product {
  return {
    id,
    name: data.name as string,
    aliases: (data.aliases as string[]) ?? [],
    barcode: data.barcode as string | undefined,
    description: data.description as string | undefined,
    category: data.category as string | undefined,
    defaultUnit: (data.defaultUnit as string) ?? "unit",
    defaultPrice: (data.defaultPrice as number) ?? 0,
    cost: data.cost as number | undefined,
    // Untracked stock is saved as null (or missing); both mean "not counted", so the app only ever sees undefined.
    quantity: typeof data.quantity === "number" ? data.quantity : undefined,
    active: (data.active as boolean) ?? true,
    notes: data.notes as string | undefined,
    createdAt: toMillis(data.createdAt),
    updatedAt: toMillis(data.updatedAt),
  };
}

export async function getAllProducts(): Promise<Product[]> {
  const snap = await productsCol().orderBy("name").get();
  return snap.docs.map((d) => hydrateProduct(d.id, d.data()));
}

export async function getProductById(id: string): Promise<Product | null> {
  const snap = await productsCol().doc(id).get();
  return snap.exists ? hydrateProduct(snap.id, snap.data()!) : null;
}

/** Fetches many products in as few round trips as possible: `documentId() in [...]` takes up to 30 ids per query. */
export async function getProductsByIds(ids: string[]): Promise<Map<string, Product>> {
  const unique = [...new Set(ids)];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += 30) chunks.push(unique.slice(i, i + 30));
  const snaps = await Promise.all(chunks.map((chunk) => productsCol().where(FieldPath.documentId(), "in", chunk).get()));
  const out = new Map<string, Product>();
  for (const snap of snaps) for (const d of snap.docs) out.set(d.id, hydrateProduct(d.id, d.data()));
  return out;
}

export async function createProduct(input: {
  name: string;
  aliases?: string[];
  barcode?: string;
  description?: string;
  category?: string;
  defaultUnit?: string;
  defaultPrice: number;
  cost?: number;
  /** Omit to leave this product's stock untracked — invoicing will never read/adjust it. */
  quantity?: number;
  notes?: string;
  operationId?: string;
}): Promise<Product> {
  assertNonNegativeAmount(input.defaultPrice, "defaultPrice");
  if (input.cost !== undefined) assertNonNegativeAmount(input.cost, "cost");
  if (input.quantity !== undefined) assertNonNegativeAmount(input.quantity, "quantity");
  const now = Date.now();
  const payload = {
    name: input.name,
    aliases: input.aliases ?? [],
    barcode: input.barcode ?? "",
    description: input.description ?? "",
    category: input.category ?? "",
    defaultUnit: input.defaultUnit ?? "unit",
    defaultPrice: input.defaultPrice,
    cost: input.cost ?? null,
    quantity: input.quantity ?? null,
    active: true,
    notes: input.notes ?? "",
    createdAt: now,
    updatedAt: now,
  };
  return runOnce(input.operationId, "createProduct", { ...input, operationId: undefined }, async (tx) => {
    const ref = productsCol().doc();
    tx.set(ref, payload);
    return hydrateProduct(ref.id, payload);
  });
}

export async function updateProduct(
  id: string,
  changes: Partial<Pick<Product, "name" | "barcode" | "description" | "category" | "defaultUnit" | "defaultPrice" | "cost" | "quantity" | "notes" | "active">>,
  operationId?: string
): Promise<void> {
  if (changes.defaultPrice !== undefined) assertNonNegativeAmount(changes.defaultPrice, "defaultPrice");
  if (changes.cost !== undefined) assertNonNegativeAmount(changes.cost, "cost");
  if (changes.quantity !== undefined) assertNonNegativeAmount(changes.quantity, "quantity");
  await runOnce(operationId, "updateProduct", { id, changes }, async (tx) => {
    const ref = productsCol().doc(id);
    if (!(await tx.get(ref)).exists) throw new NotFoundError("Product not found");
    tx.update(ref, { ...changes, updatedAt: Date.now() });
    return null;
  });
}

export async function addProductAlias(id: string, alias: string, operationId?: string): Promise<void> {
  const normalized = alias.trim();
  await runOnce(operationId, "addProductAlias", { id, alias: normalized }, async (tx) => {
    const ref = productsCol().doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new NotFoundError("Product not found");
    const product = hydrateProduct(snap.id, snap.data()!);
    if (!normalized || product.aliases.some((a) => a.toLowerCase() === normalized.toLowerCase())) return null;
    tx.update(ref, { aliases: [...product.aliases, normalized], updatedAt: Date.now() });
    return null;
  });
}

/* ------------------------------- Customers ------------------------------- */

function hydrateCustomer(id: string, data: Record<string, unknown>): Customer {
  return {
    id,
    name: data.name as string,
    aliases: (data.aliases as string[]) ?? [],
    contactName: data.contactName as string | undefined,
    phone: data.phone as string | undefined,
    email: data.email as string | undefined,
    address: data.address as string | undefined,
    shippingAddress: data.shippingAddress as string | undefined,
    notes: data.notes as string | undefined,
    defaultShipping: data.defaultShipping as number | undefined,
    ...(typeof data.credit === "number" && data.credit > 0 ? { credit: data.credit } : {}),
    active: (data.active as boolean) ?? true,
    createdAt: toMillis(data.createdAt),
    updatedAt: toMillis(data.updatedAt),
  };
}

export async function getAllCustomers(): Promise<Customer[]> {
  const snap = await customersCol().orderBy("name").get();
  return snap.docs.map((d) => hydrateCustomer(d.id, d.data()));
}

export async function getCustomerById(id: string): Promise<Customer | null> {
  const snap = await customersCol().doc(id).get();
  return snap.exists ? hydrateCustomer(snap.id, snap.data()!) : null;
}

export async function createCustomer(input: {
  name: string;
  aliases?: string[];
  contactName?: string;
  phone?: string;
  email?: string;
  address?: string;
  shippingAddress?: string;
  notes?: string;
  defaultShipping?: number;
  operationId?: string;
}): Promise<Customer> {
  if (input.defaultShipping !== undefined) assertFiniteAmount(input.defaultShipping, "defaultShipping");
  const now = Date.now();
  const payload = {
    name: input.name,
    aliases: input.aliases ?? [],
    contactName: input.contactName ?? "",
    phone: input.phone ?? "",
    email: input.email ?? "",
    address: input.address ?? "",
    shippingAddress: input.shippingAddress ?? "",
    notes: input.notes ?? "",
    defaultShipping: input.defaultShipping ?? 0,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  return runOnce(input.operationId, "createCustomer", { ...input, operationId: undefined }, async (tx) => {
    const ref = customersCol().doc();
    tx.set(ref, payload);
    return hydrateCustomer(ref.id, payload);
  });
}

export async function updateCustomer(
  id: string,
  changes: Partial<Pick<Customer, "name" | "contactName" | "phone" | "email" | "address" | "shippingAddress" | "notes" | "defaultShipping" | "active">>,
  operationId?: string
): Promise<void> {
  if (changes.defaultShipping !== undefined) assertFiniteAmount(changes.defaultShipping, "defaultShipping");
  await runOnce(operationId, "updateCustomer", { id, changes }, async (tx) => {
    const ref = customersCol().doc(id);
    if (!(await tx.get(ref)).exists) throw new NotFoundError("Customer not found");
    tx.update(ref, { ...changes, updatedAt: Date.now() });
    return null;
  });
}

export async function addCustomerAlias(id: string, alias: string, operationId?: string): Promise<void> {
  const normalized = alias.trim();
  await runOnce(operationId, "addCustomerAlias", { id, alias: normalized }, async (tx) => {
    const ref = customersCol().doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists) throw new NotFoundError("Customer not found");
    const customer = hydrateCustomer(snap.id, snap.data()!);
    if (!normalized || customer.aliases.some((a) => a.toLowerCase() === normalized.toLowerCase())) return null;
    tx.update(ref, { aliases: [...customer.aliases, normalized], updatedAt: Date.now() });
    return null;
  });
}

/* -------------------------------- Invoices -------------------------------- */

function hydrateInvoice(id: string, data: Record<string, unknown>): Invoice {
  return {
    id,
    invoiceNumber: data.invoiceNumber as string,
    date: toMillis(data.date),
    customerId: data.customerId as string | undefined,
    customerName: data.customerName as string,
    originalOrderText: data.originalOrderText as string | undefined,
    items: (data.items as InvoiceLineItem[]) ?? [],
    shipping: (data.shipping as number) ?? 0,
    discount: (data.discount as number) ?? 0,
    subtotal: data.subtotal as number,
    total: data.total as number,
    amountPaid: (data.amountPaid as number) ?? 0,
    balance: data.balance as number,
    paymentStatus: data.paymentStatus as InvoiceStatus,
    notes: data.notes as string | undefined,
    createdAt: toMillis(data.createdAt),
    updatedAt: toMillis(data.updatedAt),
    createdBy: (data.createdBy as "ai" | "user") ?? "user",
    ...(data.delivery ? { delivery: data.delivery as DeliveryInfo } : {}),
    deductedQuantities: (data.deductedQuantities as { productId: string; quantity: number }[]) ?? [],
  };
}

/**
 * Stock sync: keeps each TRACKED product's `quantity` equal to (initial stock − sum of every committed invoice's
 * deduction) without ever double-deducting or losing a reversal, no matter how many times an invoice's items or
 * status change. `Invoice.deductedQuantities` is the durable snapshot of what THIS invoice currently holds against
 * stock — never recomputed from possibly-since-changed `items` — so an edit or void always diffs against what was
 * actually taken, not what the line items happen to say right now. Untracked products (quantity undefined/null on
 * the product doc) are skipped entirely: they never appear in a snapshot and are never written to.
 *
 * Firestore transactions require every read before any write, so this is split in two: `readProductsForStock`
 * (pure read, called by the caller before ANY tx write in that transaction) and `computeStockSync` (pure compute,
 * no I/O) — the caller applies the returned product writes itself, after its own reads are done.
 */
function aggregateQuantitiesByProduct(items: InvoiceLineItem[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    if (!item.productId) continue;
    map.set(item.productId, (map.get(item.productId) ?? 0) + item.quantity);
  }
  return map;
}

async function readProductsForStock(tx: Transaction, productIds: string[]): Promise<Map<string, { ref: DocumentReference; quantity: number | null; name: string }>> {
  const out = new Map<string, { ref: DocumentReference; quantity: number | null; name: string }>();
  const unique = [...new Set(productIds)];
  const snaps = await Promise.all(unique.map((id) => tx.get(productsCol().doc(id))));
  snaps.forEach((snap, i) => {
    if (!snap.exists) return;
    const data = snap.data()!;
    out.set(unique[i], { ref: snap.ref, quantity: (data.quantity as number | null | undefined) ?? null, name: data.name as string });
  });
  return out;
}

function computeStockSync(
  productInfo: Map<string, { ref: DocumentReference; quantity: number | null; name: string }>,
  beforeDeducted: { productId: string; quantity: number }[],
  afterCommitted: boolean,
  afterItems: InvoiceLineItem[]
): { writes: { ref: DocumentReference; quantity: number }[]; deductedQuantities: { productId: string; quantity: number }[]; warnings: string[] } {
  const beforeMap = new Map(beforeDeducted.map((d) => [d.productId, d.quantity]));
  const afterMap = afterCommitted ? aggregateQuantitiesByProduct(afterItems) : new Map<string, number>();
  const productIds = new Set([...beforeMap.keys(), ...afterMap.keys()]);

  const writes: { ref: DocumentReference; quantity: number }[] = [];
  const deductedQuantities: { productId: string; quantity: number }[] = [];
  const warnings: string[] = [];

  for (const productId of productIds) {
    const info = productInfo.get(productId);
    if (!info || info.quantity === null) continue; // deleted or untracked — never deducted, never restored
    const afterQty = afterMap.get(productId) ?? 0;
    const beforeQty = beforeMap.get(productId) ?? 0;
    if (afterQty > 0) deductedQuantities.push({ productId, quantity: afterQty });
    const delta = afterQty - beforeQty; // positive: take more from stock; negative: restore
    if (delta === 0) continue;
    const newQuantity = info.quantity - delta;
    writes.push({ ref: info.ref, quantity: newQuantity });
    if (newQuantity < 0) warnings.push(`${info.name}: stock is now ${newQuantity} (went below zero).`);
  }
  return { writes, deductedQuantities, warnings };
}

export async function getAllInvoices(): Promise<Invoice[]> {
  const snap = await invoicesCol().orderBy("createdAt", "desc").get();
  return snap.docs.map((d) => hydrateInvoice(d.id, d.data()));
}

export async function getInvoice(id: string): Promise<Invoice | null> {
  const snap = await invoicesCol().doc(id).get();
  return snap.exists ? hydrateInvoice(snap.id, snap.data()!) : null;
}

/** All invoices for one customer, newest first. Single-field equality filter — no composite index required. */
export async function getInvoicesForCustomer(customerId: string): Promise<Invoice[]> {
  const snap = await invoicesCol().where("customerId", "==", customerId).get();
  return snap.docs.map((d) => hydrateInvoice(d.id, d.data())).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getInvoiceByNumber(number: string): Promise<Invoice | null> {
  const invoices = await getAllInvoices();
  return invoices.find((i) => i.invoiceNumber.toLowerCase() === number.toLowerCase()) ?? null;
}

export async function createInvoice(input: {
  customerId?: string;
  customerName: string;
  items: InvoiceLineItem[];
  shipping?: number;
  discount?: number;
  notes?: string;
  originalOrderText?: string;
  status?: InvoiceStatus;
  createdBy: "ai" | "user";
  actor: LogActor;
  /** Tags the invoice as a delivery order (prices may stay $0 until it is converted). */
  delivery?: DeliveryInfo;
  /** Makes the create idempotent: the same id never creates a second invoice or consumes a second number. */
  operationId?: string;
}): Promise<Invoice & { stockWarnings?: string[] }> {
  const now = Date.now();
  const shipping = input.shipping ?? 0;
  const discount = input.discount ?? 0;
  assertFiniteAmount(shipping, "shipping");
  assertFiniteAmount(discount, "discount");
  // Financial invariants enforced HERE, at the one boundary every caller goes through — the AI's createInvoiceDraft
  // (src/lib/ai/tools.ts) and the manual POST /api/business/invoices route both end up here, so neither can commit
  // a negative/non-finite/overflowing quantity, price or total. lineTotal is recomputed from quantity*price, never
  // trusted from the caller. Exactly 0 (an AI "incomplete" line) is preserved — only negative/non-finite is rejected.
  const items = invoiceItemsForWrite(sanitizeInvoiceItems(input.items));
  const { subtotal, total } = calcTotals(items, shipping, discount);
  assertFiniteTotals(subtotal, total);
  const paymentStatus = computePaymentStatus(total, 0, input.status ?? "draft");

  const invoiceRef = invoicesCol().doc();
  const logRef = logsCol().doc();
  const counterRef = countersCol().doc("invoiceCounter");

  const willBeCommitted = isCommittedStatus(paymentStatus);
  const stockProductIds = willBeCommitted ? [...aggregateQuantitiesByProduct(items).keys()] : [];

  const fingerprint = { customerId: input.customerId, customerName: input.customerName, items: input.items, shipping, discount, notes: input.notes, status: input.status, createdBy: input.createdBy, delivery: input.delivery };
  return runOnce(input.operationId, "createInvoice", fingerprint, async (tx) => {
    const counterSnap = await tx.get(counterRef);
    // Stock reads must happen here, before any write below — Firestore transactions require all reads before any write.
    const productInfo = stockProductIds.length ? await readProductsForStock(tx, stockProductIds) : new Map();
    const { writes: stockWrites, deductedQuantities, warnings: stockWarnings } = computeStockSync(productInfo, [], willBeCommitted, items);

    const current = counterSnap.exists ? ((counterSnap.data() as { value: number }).value as number) : 1999;
    const value = current + 1;
    const invoiceNumber = String(value);
    tx.set(counterRef, { value }, { merge: true });
    for (const w of stockWrites) tx.update(w.ref, { quantity: w.quantity, updatedAt: now });

    const payload = {
      invoiceNumber,
      date: now,
      customerId: input.customerId ?? "",
      customerName: input.customerName,
      originalOrderText: input.originalOrderText ?? "",
      items,
      shipping,
      discount,
      subtotal,
      total,
      amountPaid: 0,
      balance: total,
      paymentStatus,
      notes: input.notes ?? "",
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy,
      deductedQuantities,
      ...(input.delivery ? { delivery: input.delivery } : {}),
    };
    tx.set(invoiceRef, payload);
    tx.set(logRef, {
      invoiceId: invoiceRef.id,
      timestamp: now,
      actor: input.actor,
      action: "create",
      message: `${input.delivery ? "Delivery order" : "Invoice"} ${invoiceNumber} created for ${input.customerName} (total $${total.toFixed(2)})`,
      after: { items, shipping, discount, total },
      ...(input.operationId ? { operationId: input.operationId } : {}),
    });
    return { ...hydrateInvoice(invoiceRef.id, payload), ...(stockWarnings.length ? { stockWarnings } : {}) };
  });
}

export async function updateInvoiceWithLog(input: {
  invoiceId: string;
  /** Either the new list, or a function of the invoice as read INSIDE the transaction (avoids lost updates). */
  items?: InvoiceLineItem[] | ((before: Invoice) => InvoiceLineItem[]);
  shipping?: number;
  discount?: number;
  status?: InvoiceStatus;
  notes?: string;
  customerId?: string;
  customerName?: string;
  /**
   * "Chốt giá": the open delivery becomes the final invoice (delivery.status → "converted"). Refused unless the
   * invoice, as read inside the transaction, is an open delivery — so one is never converted twice. The timestamp
   * is taken here, not from the caller, so a retry with the same operationId has the same fingerprint.
   */
  convertDelivery?: boolean;
  actor: LogActor;
  reason: string;
  operationId?: string;
}): Promise<Invoice & { stockWarnings?: string[] }> {
  if (input.shipping !== undefined) assertFiniteAmount(input.shipping, "shipping");
  if (input.discount !== undefined) assertFiniteAmount(input.discount, "discount");
  const invoiceRef = invoicesCol().doc(input.invoiceId);
  const logRef = logsCol().doc();

  // items may be a function of the invoice read INSIDE the transaction (so it isn't representable in the
  // fingerprint the same way an array is) — the AI's per-line-edit tools (addInvoiceItem/updateInvoiceItem/
  // removeInvoiceItem) already derive a fresh, call-unique operationId per tool_use, so a marker is sufficient
  // there; the manual edit route (PATCH /api/business/invoices/:id) always sends a plain array and gets the full,
  // exact-payload fingerprint check this function is really for.
  const fingerprint = {
    invoiceId: input.invoiceId,
    items: typeof input.items === "function" ? "[function]" : input.items,
    shipping: input.shipping,
    discount: input.discount,
    status: input.status,
    notes: input.notes,
    customerId: input.customerId,
    customerName: input.customerName,
    convertDelivery: input.convertDelivery,
    reason: input.reason,
  };

  return runOnce(input.operationId, "updateInvoice", fingerprint, async (tx) => {
    const snap = await tx.get(invoiceRef);
    if (!snap.exists) throw new NotFoundError("Invoice not found");
    const before = hydrateInvoice(snap.id, snap.data()!);
    if (input.convertDelivery && !isOpenDelivery(before)) {
      throw new DomainError(`Invoice #${before.invoiceNumber} is not an open delivery order (already converted, void, or not a delivery).`);
    }

    // Financial invariants enforced HERE — the one boundary every caller (AI line-item tools and the manual edit
    // route) goes through. lineTotal is recomputed from quantity*price; exactly 0 (an AI "incomplete" line) is
    // preserved, negative/non-finite is rejected, and neither commits a partial write.
    const items = invoiceItemsForWrite(sanitizeInvoiceItems(typeof input.items === "function" ? input.items(before) : input.items ?? before.items));
    const shipping = input.shipping ?? before.shipping;
    const discount = input.discount ?? before.discount;
    const { subtotal, total } = calcTotals(items, shipping, discount);
    assertFiniteTotals(subtotal, total);
    const balance = Math.round((total - before.amountPaid) * 100) / 100;
    const paymentStatus = computePaymentStatus(total, before.amountPaid, input.status ?? before.paymentStatus);
    const now = Date.now();

    // Stock reads must happen here, before any write below — Firestore transactions require all reads before any write.
    const willBeCommitted = isCommittedStatus(paymentStatus);
    const beforeDeducted = before.deductedQuantities ?? [];
    const stockProductIds = [...new Set([...beforeDeducted.map((d) => d.productId), ...(willBeCommitted ? aggregateQuantitiesByProduct(items).keys() : [])])];
    const productInfo = stockProductIds.length ? await readProductsForStock(tx, stockProductIds) : new Map();
    const { writes: stockWrites, deductedQuantities, warnings: stockWarnings } = computeStockSync(productInfo, beforeDeducted, willBeCommitted, items);

    const updatedFields: Record<string, unknown> = {
      items,
      shipping,
      discount,
      subtotal,
      total,
      balance,
      paymentStatus,
      updatedAt: now,
      deductedQuantities,
    };
    if (input.notes !== undefined) updatedFields.notes = input.notes;
    if (input.customerId !== undefined) updatedFields.customerId = input.customerId;
    if (input.customerName !== undefined) updatedFields.customerName = input.customerName;
    if (input.convertDelivery) updatedFields.delivery = { status: "converted", convertedAt: now } satisfies DeliveryInfo;

    for (const w of stockWrites) tx.update(w.ref, { quantity: w.quantity, updatedAt: now });
    tx.update(invoiceRef, updatedFields);
    tx.set(logRef, {
      invoiceId: input.invoiceId,
      timestamp: now,
      actor: input.actor,
      action: "update",
      message: input.reason,
      before: { items: invoiceItemsForWrite(before.items), shipping: before.shipping, discount: before.discount, total: before.total, status: before.paymentStatus, ...(before.delivery ? { delivery: before.delivery } : {}) },
      after: { items, shipping, discount, total, status: paymentStatus, ...(updatedFields.delivery ? { delivery: updatedFields.delivery } : {}) },
      ...(input.operationId ? { operationId: input.operationId } : {}),
    });

    return { ...before, ...updatedFields, ...(stockWarnings.length ? { stockWarnings } : {}) } as Invoice & { stockWarnings?: string[] };
  });
}

export async function copyInvoice(input: { sourceInvoiceId: string; actor: LogActor; operationId?: string }): Promise<Invoice> {
  const source = await getInvoice(input.sourceInvoiceId);
  if (!source) throw new NotFoundError("Source invoice not found");
  return createInvoice({
    customerId: source.customerId,
    customerName: source.customerName,
    items: source.items.map((i) => ({ ...i })),
    shipping: source.shipping,
    discount: source.discount,
    notes: source.notes,
    originalOrderText: source.originalOrderText,
    status: "draft",
    createdBy: "ai",
    actor: input.actor,
    operationId: input.operationId,
  });
}

export async function recordPayment(input: {
  invoiceId: string;
  amount: number;
  method?: string;
  note?: string;
  actor: LogActor;
  by?: string;
  operationId?: string;
}): Promise<{ invoice: Invoice; payment: Payment; stockWarnings?: string[] }> {
  assertPositiveAmount(input.amount, "amount");
  const invoiceRef = invoicesCol().doc(input.invoiceId);
  const paymentRef = paymentsCol().doc();
  const logRef = logsCol().doc();

  const fingerprint = { invoiceId: input.invoiceId, amount: input.amount, method: input.method, note: input.note };
  return runOnce(input.operationId, "recordPayment", fingerprint, async (tx) => {
    const snap = await tx.get(invoiceRef);
    if (!snap.exists) throw new NotFoundError("Invoice not found");
    const before = hydrateInvoice(snap.id, snap.data()!);
    const now = Date.now();

    const amountPaid = Math.round((before.amountPaid + input.amount) * 100) / 100;
    const balance = Math.round((before.total - amountPaid) * 100) / 100;
    const paymentStatus = computePaymentStatus(before.total, amountPaid, before.paymentStatus === "draft" ? "unpaid" : before.paymentStatus);

    // Paying a still-draft invoice commits it (see computePaymentStatus above) — the one other place besides
    // createInvoice/updateInvoiceWithLog where stock can newly become deducted. Items never change here, so when
    // the invoice was already committed this is always a no-op delta (afterMap === before's own items).
    const willBeCommitted = isCommittedStatus(paymentStatus);
    const beforeDeducted = before.deductedQuantities ?? [];
    const stockProductIds = [...new Set([...beforeDeducted.map((d) => d.productId), ...(willBeCommitted ? aggregateQuantitiesByProduct(before.items).keys() : [])])];
    const productInfo = stockProductIds.length ? await readProductsForStock(tx, stockProductIds) : new Map();
    const { writes: stockWrites, deductedQuantities, warnings: stockWarnings } = computeStockSync(productInfo, beforeDeducted, willBeCommitted, before.items);

    for (const w of stockWrites) tx.update(w.ref, { quantity: w.quantity, updatedAt: now });
    tx.update(invoiceRef, { amountPaid, balance, paymentStatus, updatedAt: now, deductedQuantities });

    const paymentPayload = {
      invoiceId: input.invoiceId,
      customerId: before.customerId ?? "",
      amount: input.amount,
      method: input.method ?? "",
      note: input.note ?? "",
      createdAt: now,
      actor: input.actor,
      ...(input.by ? { by: input.by } : {}),
    };
    tx.set(paymentRef, paymentPayload);
    tx.set(logRef, {
      invoiceId: input.invoiceId,
      timestamp: now,
      actor: input.actor,
      action: "payment",
      message: `Payment of $${input.amount.toFixed(2)} recorded (balance now $${balance.toFixed(2)})`,
      before: { amountPaid: before.amountPaid, balance: before.balance },
      after: { amountPaid, balance },
      ...(input.operationId ? { operationId: input.operationId } : {}),
    });

    return {
      invoice: { ...before, amountPaid, balance, paymentStatus, updatedAt: now, deductedQuantities } as Invoice,
      payment: { id: paymentRef.id, ...paymentPayload } as Payment,
      ...(stockWarnings.length ? { stockWarnings } : {}),
    };
  });
}

export interface CustomerPaymentResult {
  receiptId: string;
  amount: number;
  allocations: PaymentAllocation[];
  /** Part of the payment no open invoice needed, added to the customer's credit. */
  leftover: number;
  /** Customer credit after this payment. */
  credit: number;
  invoices: Invoice[];
  payments: Payment[];
}

/**
 * One payment from a customer, split across their open (unpaid/partial) invoices OLDEST first — KiotViet's
 * "Phân bổ vào hóa đơn". The split itself is allocatePaymentOldestFirst (shared with the customer page's preview);
 * this only writes it, in ONE transaction: each invoice's amountPaid/balance/status, one payment row + one audit
 * log per invoice (so each invoice's own payment history stays complete), and any leftover as customer credit with
 * its own payment row (invoiceId "", unallocated: true) so the money is never lost. Every row shares a receiptId.
 *
 * Only invoices already committed (unpaid/partial) receive money, so stock is never touched here — unlike
 * recordPayment, which can commit a draft. The customer's total owed always drops by exactly the allocated amount.
 */
export async function recordCustomerPayment(input: {
  customerId: string;
  amount: number;
  method?: string;
  note?: string;
  /** "adjustment": lowers the debt by hand (not money received) — needs a reason, and can never exceed what is owed. */
  kind?: "payment" | "adjustment";
  reason?: string;
  /** When the money was received (back-dating allowed); defaults to now. */
  paidAt?: number;
  actor: LogActor;
  by?: string;
  operationId?: string;
}): Promise<CustomerPaymentResult> {
  assertPositiveAmount(input.amount, "amount");
  const isAdjustment = input.kind === "adjustment";
  if (isAdjustment && !input.reason?.trim()) throw new ValidationError("A reason is required to adjust a customer's debt.");
  const customerRef = customersCol().doc(input.customerId);
  // Which invoices belong to the customer is looked up first; every one is then re-read INSIDE the transaction,
  // so the amounts the split uses are the committed ones, never a stale copy.
  const invoiceRefs = (await invoicesCol().where("customerId", "==", input.customerId).get()).docs.map((d) => d.ref);
  const receiptId = paymentsCol().doc().id;

  const fingerprint = { customerId: input.customerId, amount: input.amount, method: input.method, note: input.note, kind: input.kind, reason: input.reason, paidAt: input.paidAt };
  return runOnce(input.operationId, "recordCustomerPayment", fingerprint, async (tx) => {
    const customerSnap = await tx.get(customerRef);
    if (!customerSnap.exists) throw new NotFoundError("Customer not found");
    const snaps = [];
    for (const ref of invoiceRefs) snaps.push(await tx.get(ref));
    const open = snaps
      .filter((s) => s.exists)
      .map((s) => hydrateInvoice(s.id, s.data()!))
      .filter((i) => i.customerId === input.customerId);
    const byId = new Map(open.map((i) => [i.id, i]));
    const { allocations, leftover } = allocatePaymentOldestFirst(open, input.amount);
    if (isAdjustment && leftover > 0) {
      throw new ValidationError(`An adjustment can only lower what is owed ($${(input.amount - leftover).toFixed(2)} right now), not create credit.`);
    }
    const now = Date.now();

    const invoices: Invoice[] = [];
    const payments: Payment[] = [];
    const base = {
      customerId: input.customerId,
      method: input.method ?? "",
      note: input.note ?? "",
      createdAt: now,
      actor: input.actor,
      receiptId,
      paidAt: input.paidAt ?? now,
      ...(input.by ? { by: input.by } : {}),
      ...(isAdjustment ? { kind: "adjustment" as const, reason: input.reason!.trim() } : {}),
    };
    for (const a of allocations) {
      const before = byId.get(a.invoiceId)!;
      const amountPaid = Math.round((before.amountPaid + a.amount) * 100) / 100;
      const balance = Math.round((before.total - amountPaid) * 100) / 100;
      const paymentStatus = computePaymentStatus(before.total, amountPaid, before.paymentStatus);
      tx.update(invoicesCol().doc(a.invoiceId), { amountPaid, balance, paymentStatus, updatedAt: now });
      const paymentRef = paymentsCol().doc();
      const payload = { ...base, invoiceId: a.invoiceId, amount: a.amount };
      tx.set(paymentRef, payload);
      tx.set(logsCol().doc(), {
        invoiceId: a.invoiceId,
        timestamp: now,
        actor: input.actor,
        action: isAdjustment ? "adjustment" : "payment",
        message: isAdjustment
          ? `Debt adjusted by -$${a.amount.toFixed(2)} (reason: ${input.reason!.trim()}), oldest invoice first (balance now $${balance.toFixed(2)})`
          : `Payment of $${a.amount.toFixed(2)} recorded from a $${input.amount.toFixed(2)} customer payment, oldest invoice first (balance now $${balance.toFixed(2)})`,
        before: { amountPaid: before.amountPaid, balance: before.balance },
        after: { amountPaid, balance },
        ...(input.operationId ? { operationId: input.operationId } : {}),
      });
      invoices.push({ ...before, amountPaid, balance, paymentStatus, updatedAt: now });
      payments.push({ id: paymentRef.id, ...payload });
    }

    const creditBefore = hydrateCustomer(customerSnap.id, customerSnap.data()!).credit ?? 0;
    const credit = Math.round((creditBefore + leftover) * 100) / 100;
    if (leftover > 0) {
      tx.update(customerRef, { credit, updatedAt: now });
      const paymentRef = paymentsCol().doc();
      const payload = { ...base, invoiceId: "", amount: leftover, unallocated: true };
      tx.set(paymentRef, payload);
      payments.push({ id: paymentRef.id, ...payload });
    }

    return { receiptId, amount: input.amount, allocations, leftover, credit, invoices, payments };
  });
}

/**
 * Fixes a payment entered with the wrong amount ("edit") or takes it back entirely ("cancel") — the "dangerous but
 * necessary" debt correction. Nothing is ever deleted: the payment row keeps its id, an edit changes `amount`, a
 * cancel marks it `cancelled` (amount kept for the record), and every change is appended to the row's `history`
 * (who, when, before → after, reason) plus an audit log on the invoice. In the SAME transaction the difference is
 * applied where the money went: the invoice's amountPaid/balance/status, or the customer's credit for the extra
 * part of a customer payment. Refused when the result would make no sense (paying an invoice beyond its total,
 * credit below zero, a cancelled payment changed again).
 */
export async function changePayment(input: {
  paymentId: string;
  action: "edit" | "cancel";
  /** New amount, required for "edit". */
  amount?: number;
  reason: string;
  actor: LogActor;
  by?: string;
  operationId?: string;
}): Promise<{ payment: Payment; invoice?: Invoice; credit?: number }> {
  const reason = input.reason?.trim() ?? "";
  if (!reason) throw new ValidationError("A reason is required to change a payment.");
  if (input.action === "edit") assertPositiveAmount(input.amount as number, "amount");
  else if (input.action !== "cancel") throw new ValidationError("Unknown payment change.");
  const paymentRef = paymentsCol().doc(input.paymentId);

  const fingerprint = { paymentId: input.paymentId, action: input.action, amount: input.amount, reason };
  return runOnce(input.operationId, "changePayment", fingerprint, async (tx) => {
    const snap = await tx.get(paymentRef);
    if (!snap.exists) throw new NotFoundError("Payment not found");
    const before = { id: snap.id, ...snap.data() } as Payment;
    if (before.cancelled) throw new ValidationError("This payment was already cancelled.");
    const newAmount = input.action === "cancel" ? 0 : Math.round((input.amount as number) * 100) / 100;
    const delta = Math.round((newAmount - before.amount) * 100) / 100;
    if (input.action === "edit" && delta === 0) throw new ValidationError("The new amount is the same as the old one.");
    const now = Date.now();
    const what = before.kind === "adjustment" ? "Debt adjustment" : "Payment";
    const change = { action: input.action, at: now, actor: input.actor, ...(input.by ? { by: input.by } : {}), reason, amountBefore: before.amount, amountAfter: newAmount };

    let invoice: Invoice | undefined;
    let credit: number | undefined;
    if (before.invoiceId) {
      const invoiceRef = invoicesCol().doc(before.invoiceId);
      const invSnap = await tx.get(invoiceRef);
      if (!invSnap.exists) throw new NotFoundError("The invoice this payment belongs to was not found.");
      const inv = hydrateInvoice(invSnap.id, invSnap.data()!);
      const amountPaid = Math.round((inv.amountPaid + delta) * 100) / 100;
      if (amountPaid < 0) throw new ValidationError(`Invoice #${inv.invoiceNumber} shows less paid than this payment — please check its payments first.`);
      if (delta > 0 && amountPaid > inv.total) {
        throw new ValidationError(`That would pay invoice #${inv.invoiceNumber} more than its total ($${inv.total.toFixed(2)}). Record the extra as a new customer payment instead.`);
      }
      const balance = Math.round((inv.total - amountPaid) * 100) / 100;
      const paymentStatus = computePaymentStatus(inv.total, amountPaid, inv.paymentStatus);
      tx.update(invoiceRef, { amountPaid, balance, paymentStatus, updatedAt: now });
      tx.set(logsCol().doc(), {
        invoiceId: inv.id,
        timestamp: now,
        actor: input.actor,
        action: input.action === "cancel" ? "payment_cancel" : "payment_edit",
        message:
          input.action === "cancel"
            ? `${what} of $${before.amount.toFixed(2)} cancelled (reason: ${reason}) — balance now $${balance.toFixed(2)}`
            : `${what} changed from $${before.amount.toFixed(2)} to $${newAmount.toFixed(2)} (reason: ${reason}) — balance now $${balance.toFixed(2)}`,
        before: { amountPaid: inv.amountPaid, balance: inv.balance },
        after: { amountPaid, balance },
        ...(input.operationId ? { operationId: input.operationId } : {}),
      });
      invoice = { ...inv, amountPaid, balance, paymentStatus, updatedAt: now };
    } else {
      if (!before.customerId) throw new ValidationError("This payment is not linked to an invoice or a customer.");
      const customerRef = customersCol().doc(before.customerId);
      const custSnap = await tx.get(customerRef);
      if (!custSnap.exists) throw new NotFoundError("Customer not found");
      const creditBefore = hydrateCustomer(custSnap.id, custSnap.data()!).credit ?? 0;
      credit = Math.round((creditBefore + delta) * 100) / 100;
      if (credit < 0) throw new ValidationError(`The customer only has $${creditBefore.toFixed(2)} credit left, so this cannot be lowered that much.`);
      tx.update(customerRef, { credit, updatedAt: now });
    }

    const updated = {
      ...(input.action === "cancel" ? { cancelled: true } : { amount: newAmount }),
      history: [...(before.history ?? []), change],
    };
    tx.update(paymentRef, updated);
    return { payment: { ...before, ...updated }, ...(invoice ? { invoice } : {}), ...(credit !== undefined ? { credit } : {}) };
  });
}

export async function getPaymentById(id: string): Promise<Payment | null> {
  if (!id) return null;
  const snap = await paymentsCol().doc(id).get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as Payment) : null;
}

export async function getPaymentsForCustomer(customerId: string): Promise<Payment[]> {
  const snap = await paymentsCol().where("customerId", "==", customerId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Payment).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getPaymentsForInvoice(invoiceId: string): Promise<Payment[]> {
  const snap = await paymentsCol().where("invoiceId", "==", invoiceId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Payment).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getAllPayments(): Promise<Payment[]> {
  const snap = await paymentsCol().get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Payment).sort((a, b) => b.createdAt - a.createdAt);
}

export async function getCustomerDebt(customerId: string): Promise<{ balance: number; openInvoices: Invoice[] }> {
  const invoices = await getInvoicesForCustomer(customerId);
  const openInvoices = invoices.filter((i) => i.paymentStatus === "unpaid" || i.paymentStatus === "partial");
  const balance = Math.round(openInvoices.reduce((sum, i) => sum + i.balance, 0) * 100) / 100;
  return { balance, openInvoices };
}

export async function getUnpaidInvoices(statusFilter?: InvoiceStatus): Promise<Invoice[]> {
  const invoices = await getAllInvoices();
  if (statusFilter) return invoices.filter((i) => i.paymentStatus === statusFilter);
  return invoices.filter((i) => i.paymentStatus === "unpaid" || i.paymentStatus === "partial");
}

export async function getInvoiceLogs(invoiceId: string): Promise<InvoiceLog[]> {
  const snap = await logsCol().where("invoiceId", "==", invoiceId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as InvoiceLog).sort((a, b) => b.timestamp - a.timestamp);
}

/* ------------------------- Custom invoice print info ------------------------- */

const DEFAULT_FROM: PrintParty = {
  name: "N&E ENTERPRISE INC",
  address: "14902 Moran St, Suite A\nWestminster, CA 92683",
  phone: "714-233-8888",
  email: "Nneenterpriseinc@gmail.com",
};

export async function getCustomInvoiceDefaults(): Promise<CustomInvoiceDefaults> {
  const snap = await settingsCol().doc("customInvoiceDefaults").get();
  const data = snap.exists ? (snap.data() as Partial<CustomInvoiceDefaults>) : {};
  return { from: data.from ?? DEFAULT_FROM, terms: data.terms ?? "" };
}

export async function getInvoicePrintInfo(invoiceId: string): Promise<InvoicePrintInfo | null> {
  const snap = await printInfoCol().doc(invoiceId).get();
  return snap.exists ? ({ ...(snap.data() as Omit<InvoicePrintInfo, "invoiceId">), invoiceId }) : null;
}

/**
 * Saves the print information for one invoice (overwrites the previous version) and remembers its company block
 * and terms as the defaults for the next one. Never reads or writes the invoice itself: the printout's customer,
 * items and money always come from the live invoice, so nothing here can change a price, a total or a debt.
 */
export async function saveInvoicePrintInfo(info: Omit<InvoicePrintInfo, "updatedAt">): Promise<InvoicePrintInfo> {
  const invoiceRef = invoicesCol().doc(info.invoiceId);
  const ref = printInfoCol().doc(info.invoiceId);
  const defaultsRef = settingsCol().doc("customInvoiceDefaults");
  return db().runTransaction(async (tx) => {
    if (!(await tx.get(invoiceRef)).exists) throw new NotFoundError("Không tìm thấy hóa đơn.");
    const now = Date.now();
    const { invoiceId, ...rest } = info;
    const saved = { ...rest, updatedAt: now };
    tx.set(ref, saved);
    tx.set(defaultsRef, { from: info.from, terms: info.terms, updatedAt: now });
    return { ...saved, invoiceId };
  });
}
