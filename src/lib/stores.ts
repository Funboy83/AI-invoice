/**
 * The stores this one app runs. Each store has its OWN customers, products, invoices, payments, invoice numbers,
 * custom-invoice settings and AI chat history — nothing is shared between them except the login.
 *
 * Where each store's data lives in Firestore:
 *   - "main" (Wholesale) keeps the top-level collections it has always used (products, customers, invoices, …), so
 *     the existing data is the Wholesale store as-is: nothing was copied, moved or rewritten to add stores.
 *   - every other store lives under stores/{storeId}/… (e.g. stores/phone/invoices), a separate area that the
 *     Wholesale store's queries can never reach, and vice versa.
 *
 * Shared by the browser (store switcher, reads) and the server (businessStore.ts, auth.ts), so both sides always
 * agree on the list and on the paths.
 */
export interface StoreInfo {
  id: string;
  name: string;
  /** First invoice number this store hands out (each store has its own counter). */
  firstInvoiceNumber: number;
  /** Tailwind classes for the store badge, so the two stores never look alike. */
  badgeClass: string;
  dotClass: string;
}

export const DEFAULT_STORE_ID = "main";

export const STORES: readonly StoreInfo[] = [
  { id: "main", name: "Wholesale", firstInvoiceNumber: 2000, badgeClass: "bg-indigo-50 text-indigo-700 border-indigo-200", dotClass: "bg-indigo-500" },
  { id: "phone", name: "Phone store", firstInvoiceNumber: 1000, badgeClass: "bg-emerald-50 text-emerald-700 border-emerald-200", dotClass: "bg-emerald-500" },
];

/** The header every browser API call carries to say which store it is for. */
export const STORE_HEADER = "x-store-id";

export function isStoreId(value: unknown): value is string {
  return typeof value === "string" && STORES.some((s) => s.id === value);
}

export function storeInfo(storeId: string): StoreInfo {
  const info = STORES.find((s) => s.id === storeId);
  if (!info) throw new Error(`Unknown store "${storeId}".`);
  return info;
}

/**
 * The Firestore collection path for one store's collection. Refuses an unknown store id outright, so a typo or a
 * forged value can never invent a new data area or fall back to another store's data.
 */
export function storeCollectionPath(storeId: string, collectionName: string): string {
  if (!isStoreId(storeId)) throw new Error(`Unknown store "${storeId}".`);
  return storeId === DEFAULT_STORE_ID ? collectionName : `stores/${storeId}/${collectionName}`;
}
