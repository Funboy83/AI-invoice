import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  getDocs,
  query,
  orderBy,
  onSnapshot,
  runTransaction,
  Timestamp,
} from "firebase/firestore";
import { db } from "./firebase";
import type {
  Customer,
  Invoice,
  InvoiceLineItem,
  InvoiceLog,
  InvoiceStatus,
  LogActor,
  Payment,
  Product,
} from "./types";

const productsCol = collection(db, "products");
const customersCol = collection(db, "customers");
const invoicesCol = collection(db, "invoices");
const paymentsCol = collection(db, "payments");
const logsCol = collection(db, "invoiceLogs");
const countersCol = collection(db, "counters");

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
    active: (data.active as boolean) ?? true,
    notes: data.notes as string | undefined,
    createdAt: toMillis(data.createdAt),
    updatedAt: toMillis(data.updatedAt),
  };
}

export function watchProducts(cb: (products: Product[]) => void) {
  const q = query(productsCol, orderBy("name"));
  return onSnapshot(q, (snap) => cb(snap.docs.map((d) => hydrateProduct(d.id, d.data()))));
}

export async function getAllProducts(): Promise<Product[]> {
  const snap = await getDocs(query(productsCol, orderBy("name")));
  return snap.docs.map((d) => hydrateProduct(d.id, d.data()));
}

export async function getProductById(id: string): Promise<Product | null> {
  const snap = await getDoc(doc(db, "products", id));
  return snap.exists() ? hydrateProduct(snap.id, snap.data()) : null;
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
  notes?: string;
}): Promise<Product> {
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
    active: true,
    notes: input.notes ?? "",
    createdAt: now,
    updatedAt: now,
  };
  const ref = await addDoc(productsCol, payload);
  return hydrateProduct(ref.id, payload);
}

export async function updateProduct(
  id: string,
  changes: Partial<Pick<Product, "name" | "barcode" | "description" | "category" | "defaultUnit" | "defaultPrice" | "cost" | "notes" | "active">>
): Promise<void> {
  await updateDoc(doc(db, "products", id), { ...changes, updatedAt: Date.now() });
}

export async function addProductAlias(id: string, alias: string): Promise<void> {
  const product = await getProductById(id);
  if (!product) throw new Error("Product not found");
  const normalized = alias.trim();
  if (!normalized || product.aliases.some((a) => a.toLowerCase() === normalized.toLowerCase())) return;
  await updateDoc(doc(db, "products", id), {
    aliases: [...product.aliases, normalized],
    updatedAt: Date.now(),
  });
}

export async function deleteProduct(id: string): Promise<void> {
  await deleteDoc(doc(db, "products", id));
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
    active: (data.active as boolean) ?? true,
    createdAt: toMillis(data.createdAt),
    updatedAt: toMillis(data.updatedAt),
  };
}

export function watchCustomers(cb: (customers: Customer[]) => void) {
  const q = query(customersCol, orderBy("name"));
  return onSnapshot(q, (snap) => cb(snap.docs.map((d) => hydrateCustomer(d.id, d.data()))));
}

export async function getAllCustomers(): Promise<Customer[]> {
  const snap = await getDocs(query(customersCol, orderBy("name")));
  return snap.docs.map((d) => hydrateCustomer(d.id, d.data()));
}

export async function getCustomerById(id: string): Promise<Customer | null> {
  const snap = await getDoc(doc(db, "customers", id));
  return snap.exists() ? hydrateCustomer(snap.id, snap.data()) : null;
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
}): Promise<Customer> {
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
  const ref = await addDoc(customersCol, payload);
  return hydrateCustomer(ref.id, payload);
}

export async function updateCustomer(
  id: string,
  changes: Partial<Pick<Customer, "name" | "contactName" | "phone" | "email" | "address" | "shippingAddress" | "notes" | "defaultShipping" | "active">>
): Promise<void> {
  await updateDoc(doc(db, "customers", id), { ...changes, updatedAt: Date.now() });
}

export async function addCustomerAlias(id: string, alias: string): Promise<void> {
  const customer = await getCustomerById(id);
  if (!customer) throw new Error("Customer not found");
  const normalized = alias.trim();
  if (!normalized || customer.aliases.some((a) => a.toLowerCase() === normalized.toLowerCase())) return;
  await updateDoc(doc(db, "customers", id), {
    aliases: [...customer.aliases, normalized],
    updatedAt: Date.now(),
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
  };
}

export function watchInvoices(cb: (invoices: Invoice[]) => void) {
  const q = query(invoicesCol, orderBy("createdAt", "desc"));
  return onSnapshot(q, (snap) => cb(snap.docs.map((d) => hydrateInvoice(d.id, d.data()))));
}

export async function getAllInvoices(): Promise<Invoice[]> {
  const snap = await getDocs(query(invoicesCol, orderBy("createdAt", "desc")));
  return snap.docs.map((d) => hydrateInvoice(d.id, d.data()));
}

export async function getInvoice(id: string): Promise<Invoice | null> {
  const snap = await getDoc(doc(db, "invoices", id));
  return snap.exists() ? hydrateInvoice(snap.id, snap.data()) : null;
}

export async function getInvoiceByNumber(number: string): Promise<Invoice | null> {
  const invoices = await getAllInvoices();
  return invoices.find((i) => i.invoiceNumber.toLowerCase() === number.toLowerCase()) ?? null;
}

function calcTotals(items: InvoiceLineItem[], shipping: number, discount: number) {
  const subtotal = Math.round(items.reduce((sum, li) => sum + li.lineTotal, 0) * 100) / 100;
  const total = Math.round((subtotal + shipping - discount) * 100) / 100;
  return { subtotal, total };
}

/** draft/void are manual states; otherwise status is derived from paid amount vs total. */
function computePaymentStatus(total: number, amountPaid: number, manualStatus?: InvoiceStatus): InvoiceStatus {
  if (manualStatus === "void" || manualStatus === "draft") return manualStatus;
  if (amountPaid <= 0) return "unpaid";
  if (amountPaid >= total) return "paid";
  return "partial";
}

async function nextInvoiceNumber(): Promise<string> {
  const counterRef = doc(countersCol, "invoiceCounter");
  const next = await runTransaction(db, async (tx) => {
    const snap = await tx.get(counterRef);
    const current = snap.exists() ? (snap.data().value as number) : 1337;
    const value = current + 1;
    tx.set(counterRef, { value }, { merge: true });
    return value;
  });
  return String(next);
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
}): Promise<Invoice> {
  const invoiceNumber = await nextInvoiceNumber();
  const now = Date.now();
  const shipping = input.shipping ?? 0;
  const discount = input.discount ?? 0;
  const { subtotal, total } = calcTotals(input.items, shipping, discount);
  const paymentStatus = computePaymentStatus(total, 0, input.status ?? "draft");

  const invoiceRef = doc(invoicesCol);
  const payload = {
    invoiceNumber,
    date: now,
    customerId: input.customerId ?? "",
    customerName: input.customerName,
    originalOrderText: input.originalOrderText ?? "",
    items: input.items,
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
  };

  await runTransaction(db, async (tx) => {
    tx.set(invoiceRef, payload);
    const logRef = doc(logsCol);
    tx.set(logRef, {
      invoiceId: invoiceRef.id,
      timestamp: now,
      actor: input.actor,
      action: "create",
      message: `Invoice ${invoiceNumber} created for ${input.customerName} (total $${total.toFixed(2)})`,
      after: { items: input.items, shipping, discount, total },
    });
  });

  return hydrateInvoice(invoiceRef.id, payload);
}

export async function updateInvoiceWithLog(input: {
  invoiceId: string;
  items?: InvoiceLineItem[];
  shipping?: number;
  discount?: number;
  status?: InvoiceStatus;
  notes?: string;
  customerId?: string;
  customerName?: string;
  actor: LogActor;
  reason: string;
}): Promise<Invoice> {
  const invoiceRef = doc(db, "invoices", input.invoiceId);

  const result = await runTransaction(db, async (tx) => {
    const snap = await tx.get(invoiceRef);
    if (!snap.exists()) throw new Error("Invoice not found");
    const before = hydrateInvoice(snap.id, snap.data());

    const items = input.items ?? before.items;
    const shipping = input.shipping ?? before.shipping;
    const discount = input.discount ?? before.discount;
    const { subtotal, total } = calcTotals(items, shipping, discount);
    const balance = Math.round((total - before.amountPaid) * 100) / 100;
    const paymentStatus = computePaymentStatus(total, before.amountPaid, input.status ?? before.paymentStatus);
    const now = Date.now();

    const updatedFields: Record<string, unknown> = {
      items,
      shipping,
      discount,
      subtotal,
      total,
      balance,
      paymentStatus,
      updatedAt: now,
    };
    if (input.notes !== undefined) updatedFields.notes = input.notes;
    if (input.customerId !== undefined) updatedFields.customerId = input.customerId;
    if (input.customerName !== undefined) updatedFields.customerName = input.customerName;

    tx.update(invoiceRef, updatedFields);

    const logRef = doc(logsCol);
    tx.set(logRef, {
      invoiceId: input.invoiceId,
      timestamp: now,
      actor: input.actor,
      action: "update",
      message: input.reason,
      before: { items: before.items, shipping: before.shipping, discount: before.discount, total: before.total, status: before.paymentStatus },
      after: { items, shipping, discount, total, status: paymentStatus },
    });

    return {
      ...before,
      ...updatedFields,
    } as Invoice;
  });

  return result;
}

export async function copyInvoice(input: {
  sourceInvoiceId: string;
  actor: LogActor;
}): Promise<Invoice> {
  const source = await getInvoice(input.sourceInvoiceId);
  if (!source) throw new Error("Source invoice not found");
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
  });
}

export async function recordPayment(input: {
  invoiceId: string;
  amount: number;
  method?: string;
  note?: string;
  actor: LogActor;
}): Promise<{ invoice: Invoice; payment: Payment }> {
  const invoiceRef = doc(db, "invoices", input.invoiceId);
  const paymentRef = doc(paymentsCol);

  const result = await runTransaction(db, async (tx) => {
    const snap = await tx.get(invoiceRef);
    if (!snap.exists()) throw new Error("Invoice not found");
    const before = hydrateInvoice(snap.id, snap.data());
    const now = Date.now();

    const amountPaid = Math.round((before.amountPaid + input.amount) * 100) / 100;
    const balance = Math.round((before.total - amountPaid) * 100) / 100;
    const paymentStatus = computePaymentStatus(
      before.total,
      amountPaid,
      before.paymentStatus === "draft" ? "unpaid" : before.paymentStatus
    );

    tx.update(invoiceRef, { amountPaid, balance, paymentStatus, updatedAt: now });

    const paymentPayload = {
      invoiceId: input.invoiceId,
      customerId: before.customerId ?? "",
      amount: input.amount,
      method: input.method ?? "",
      note: input.note ?? "",
      createdAt: now,
      actor: input.actor,
    };
    tx.set(paymentRef, paymentPayload);

    const logRef = doc(logsCol);
    tx.set(logRef, {
      invoiceId: input.invoiceId,
      timestamp: now,
      actor: input.actor,
      action: "payment",
      message: `Payment of $${input.amount.toFixed(2)} recorded (balance now $${balance.toFixed(2)})`,
      before: { amountPaid: before.amountPaid, balance: before.balance },
      after: { amountPaid, balance },
    });

    return {
      invoice: { ...before, amountPaid, balance, paymentStatus, updatedAt: now } as Invoice,
      payment: { id: paymentRef.id, ...paymentPayload } as Payment,
    };
  });

  return result;
}

export async function getPaymentsForInvoice(invoiceId: string): Promise<Payment[]> {
  const snap = await getDocs(paymentsCol);
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() } as Payment))
    .filter((p) => p.invoiceId === invoiceId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getAllPayments(): Promise<Payment[]> {
  const snap = await getDocs(paymentsCol);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as Payment)).sort((a, b) => b.createdAt - a.createdAt);
}


export async function getCustomerDebt(customerId: string): Promise<{ balance: number; openInvoices: Invoice[] }> {
  const invoices = await getAllInvoices();
  const openInvoices = invoices.filter(
    (i) => i.customerId === customerId && (i.paymentStatus === "unpaid" || i.paymentStatus === "partial")
  );
  const balance = Math.round(openInvoices.reduce((sum, i) => sum + i.balance, 0) * 100) / 100;
  return { balance, openInvoices };
}

export async function getUnpaidInvoices(statusFilter?: InvoiceStatus): Promise<Invoice[]> {
  const invoices = await getAllInvoices();
  if (statusFilter) return invoices.filter((i) => i.paymentStatus === statusFilter);
  return invoices.filter((i) => i.paymentStatus === "unpaid" || i.paymentStatus === "partial");
}

export function watchInvoiceLogs(invoiceId: string, cb: (logs: InvoiceLog[]) => void) {
  const q = query(logsCol, orderBy("timestamp", "desc"));
  return onSnapshot(q, (snap) => {
    cb(
      snap.docs
        .map((d) => ({ id: d.id, ...d.data() } as InvoiceLog))
        .filter((l) => l.invoiceId === invoiceId)
    );
  });
}
