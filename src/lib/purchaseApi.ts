"use client";

/**
 * Browser helpers for the "Buy from vendor" endpoints (src/app/api/business/vendors/**, purchases/**). Unlike
 * invoices, vendor and purchase data is read through the server too, so no Firestore security-rule change is needed.
 * Every write takes an operationId the page keeps stable across retries of the SAME action (see useActionId).
 */
import type { AuthedFetch } from "./chat/types";
import type { Purchase, Vendor, VendorPayment } from "./types";

async function call<T>(authedFetch: AuthedFetch, method: "GET" | "POST" | "PATCH", url: string, body?: unknown): Promise<T> {
  const res = await authedFetch(url, method === "GET" ? { method } : { method, body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Something went wrong.");
  return data as T;
}

export interface VendorInput {
  name: string;
  contactName?: string;
  phone?: string;
  email?: string;
  address?: string;
  notes?: string;
}

export const getVendorsApi = (f: AuthedFetch) => call<{ vendors: Vendor[]; owed: Record<string, number> }>(f, "GET", "/api/business/vendors");
export const getVendorApi = (f: AuthedFetch, id: string) => call<{ vendor: Vendor; purchases: Purchase[] }>(f, "GET", `/api/business/vendors/${id}`);
export const createVendorApi = async (f: AuthedFetch, input: VendorInput, operationId: string) =>
  (await call<{ vendor: Vendor }>(f, "POST", "/api/business/vendors", { ...input, operationId })).vendor;
export const updateVendorApi = (f: AuthedFetch, id: string, changes: Partial<VendorInput>, operationId: string) =>
  call(f, "PATCH", `/api/business/vendors/${id}`, { ...changes, operationId });

export interface CreatePurchaseInput {
  vendorId: string;
  vendorInvoiceNumber: string;
  dateKey: string;
  items: { productId: string; quantity: number; cost: number; unit?: string }[];
  shipping?: number;
  discount?: number;
  notes?: string;
  updateCost: boolean;
  paidNow?: number;
  payMethod?: string;
}

export const getPurchasesApi = (f: AuthedFetch) => call<{ purchases: Purchase[] }>(f, "GET", "/api/business/purchases");
export const getPurchaseApi = (f: AuthedFetch, id: string) => call<{ purchase: Purchase; payments: VendorPayment[] }>(f, "GET", `/api/business/purchases/${id}`);
export const createPurchaseApi = (f: AuthedFetch, input: CreatePurchaseInput, operationId: string) =>
  call<{ purchase: Purchase; stockNotes: string[] }>(f, "POST", "/api/business/purchases", { ...input, operationId });
export const updatePurchaseInfoApi = (f: AuthedFetch, id: string, changes: { vendorInvoiceNumber?: string; dateKey?: string; notes?: string }, operationId: string) =>
  call<{ purchase: Purchase }>(f, "PATCH", `/api/business/purchases/${id}`, { ...changes, operationId });
export const recordVendorPaymentApi = (f: AuthedFetch, id: string, amount: number, method: string, operationId: string) =>
  call<{ purchase: Purchase }>(f, "POST", `/api/business/purchases/${id}/payments`, { amount, method, operationId });
export const voidPurchaseApi = (f: AuthedFetch, id: string, operationId: string) =>
  call<{ purchase: Purchase; stockWarnings: string[] }>(f, "POST", `/api/business/purchases/${id}/void`, { operationId });

/** Accent- and case-insensitive text for search, so "hoa" finds "Hòa" and "inv 12" finds "INV12". */
export const normalizeSearch = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().trim();

/** Does this purchase match the search box? Looks at vendor invoice #, our PO #, vendor name, products and notes. */
export function purchaseMatches(p: Purchase, query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  const compactQ = q.replace(/\s+/g, "");
  const fields = [p.vendorInvoiceNumber, p.purchaseNumber, p.vendorName, p.notes, ...p.items.map((i) => i.productName)];
  return fields.some((f) => {
    const n = normalizeSearch(f ?? "");
    return n.includes(q) || n.replace(/\s+/g, "").includes(compactQ);
  });
}

export const money = (n: number) => `$${n.toFixed(2)}`;

export const purchaseStatusStyles: Record<string, string> = {
  unpaid: "bg-blue-100 text-blue-700",
  partial: "bg-amber-100 text-amber-700",
  paid: "bg-emerald-100 text-emerald-700",
  void: "bg-red-100 text-red-700",
};

export const purchaseStatusLabel: Record<string, string> = { unpaid: "Unpaid", partial: "Partly paid", paid: "Paid", void: "Cancelled" };

/** "2026-10-15" → "10/15/2026" without any time-zone shift. */
export function formatDateKey(key: string): string {
  const [y, m, d] = key.split("-");
  return y && m && d ? `${Number(m)}/${Number(d)}/${y}` : key;
}
