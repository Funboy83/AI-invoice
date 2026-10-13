"use client";

/**
 * Client-side helpers for the manual business mutation endpoints (src/app/api/business/**), used by the 4
 * business pages. Reads stay on the client SDK (src/lib/store.ts's watchX/getX, gated by Firestore rules);
 * everything here is a WRITE, which now requires an authenticated, membership-checked, validated server call —
 * see src/lib/server/businessStore.ts. Each function throws a plain Error with the server's message on failure,
 * matching the `catch (e) { setError(e instanceof Error ? e.message : …) }` pattern already used on every page.
 *
 * `operationId` is REQUIRED (not generated in here) on every mutating call: the caller — a page component — owns
 * one stable id per intended action and passes the SAME id on every retry of that SAME action (see useActionId
 * below, and the pages' own use of it). A function that generated its own fresh id on every call would give a
 * lost-response retry a brand-new key, defeating the server's idempotency ledger for exactly the case it exists
 * for; this shape makes that mistake a compile error instead of a subtle bug.
 */
import type { AuthedFetch } from "./chat/types";
import type { Customer, CustomInvoiceDefaults, Invoice, InvoicePrintInfo, InvoiceLineItem, InvoiceStatus, Product } from "./types";

async function call<T>(authedFetch: AuthedFetch, method: "GET" | "POST" | "PATCH" | "PUT", url: string, body: unknown): Promise<T> {
  const res = await authedFetch(url, method === "GET" ? { method } : { method, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Có lỗi xảy ra.");
  return data as T;
}

/** One id per intended action (new invoice, this edit, this payment) — callers reuse it across retries, see useActionId. */
export const newOperationId = () =>
  (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

export interface CreateProductInput {
  name: string;
  aliases?: string[];
  defaultUnit?: string;
  defaultPrice: number;
  cost?: number;
  /** Omit to leave stock untracked for this product — invoicing will never read/adjust it. */
  quantity?: number;
  category?: string;
  barcode?: string;
  notes?: string;
}
export async function createProductApi(authedFetch: AuthedFetch, input: CreateProductInput, operationId: string): Promise<Product> {
  const { product } = await call<{ product: Product }>(authedFetch, "POST", "/api/business/products", { ...input, operationId });
  return product;
}

export async function updateProductApi(
  authedFetch: AuthedFetch,
  id: string,
  changes: Partial<Pick<Product, "name" | "defaultUnit" | "defaultPrice" | "cost" | "quantity" | "category" | "notes" | "active">>,
  operationId: string
): Promise<void> {
  await call(authedFetch, "PATCH", `/api/business/products/${id}`, { ...changes, operationId });
}

export interface CreateCustomerInput {
  name: string;
  aliases?: string[];
  contactName?: string;
  phone?: string;
  email?: string;
  address?: string;
  shippingAddress?: string;
  notes?: string;
  defaultShipping?: number;
}
export async function createCustomerApi(authedFetch: AuthedFetch, input: CreateCustomerInput, operationId: string): Promise<Customer> {
  const { customer } = await call<{ customer: Customer }>(authedFetch, "POST", "/api/business/customers", { ...input, operationId });
  return customer;
}

export async function updateCustomerApi(
  authedFetch: AuthedFetch,
  id: string,
  changes: Partial<Pick<Customer, "name" | "contactName" | "phone" | "email" | "address" | "shippingAddress" | "notes" | "defaultShipping" | "active">>,
  operationId: string
): Promise<void> {
  await call(authedFetch, "PATCH", `/api/business/customers/${id}`, { ...changes, operationId });
}

export interface CreateInvoiceInput {
  customerId?: string;
  customerName: string;
  items: InvoiceLineItem[];
  shipping?: number;
  discount?: number;
  notes?: string;
  /** Tag as a delivery order (prices may stay $0 until "Chốt giá"). */
  delivery?: boolean;
}
export async function createInvoiceApi(authedFetch: AuthedFetch, input: CreateInvoiceInput, operationId: string): Promise<{ invoice: Invoice; stockWarnings?: string[] }> {
  return call<{ invoice: Invoice; stockWarnings?: string[] }>(authedFetch, "POST", "/api/business/invoices", { ...input, operationId });
}

export interface UpdateInvoiceInput {
  items?: InvoiceLineItem[];
  shipping?: number;
  discount?: number;
  status?: InvoiceStatus;
  notes?: string;
  reason: string;
  /** "Chốt giá": these prices are final; the open delivery becomes a normal invoice. */
  convertDelivery?: boolean;
}
export async function updateInvoiceApi(authedFetch: AuthedFetch, id: string, input: UpdateInvoiceInput, operationId: string): Promise<{ invoice: Invoice; stockWarnings?: string[] }> {
  return call<{ invoice: Invoice; stockWarnings?: string[] }>(authedFetch, "PATCH", `/api/business/invoices/${id}`, { ...input, operationId });
}

export async function recordPaymentApi(authedFetch: AuthedFetch, invoiceId: string, amount: number, method: string | undefined, operationId: string): Promise<{ stockWarnings?: string[] }> {
  return call<{ stockWarnings?: string[] }>(authedFetch, "POST", `/api/business/invoices/${invoiceId}/payments`, { amount, method, operationId });
}

/* Custom Invoice: print information for an existing invoice, read and saved through the server. */
export async function getInvoicePrintInfoApi(authedFetch: AuthedFetch, invoiceId: string): Promise<{ info: InvoicePrintInfo | null; defaults: CustomInvoiceDefaults }> {
  return call(authedFetch, "GET", `/api/business/custom-invoices/${invoiceId}`, undefined);
}

export async function saveInvoicePrintInfoApi(authedFetch: AuthedFetch, info: Omit<InvoicePrintInfo, "updatedAt">): Promise<InvoicePrintInfo> {
  const { invoiceId, ...body } = info;
  const { info: saved } = await call<{ info: InvoicePrintInfo }>(authedFetch, "PUT", `/api/business/custom-invoices/${invoiceId}`, body);
  return saved;
}

/** Today's (or a timestamp's) LOCAL calendar date as "YYYY-MM-DD" — what a date input shows and a Custom Invoice stores. */
export function toDateKey(ms: number = Date.now()): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
