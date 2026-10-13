import type { Invoice } from "./types";

/**
 * Splits one customer's invoices for the customer page's follow-up view. Pure (no Firestore) so it is trivially
 * testable. "Owed" uses the exact same rule as getCustomerDebt in store.ts / server/businessStore.ts — the sum of
 * `balance` over unpaid + partial invoices, rounded to cents — so the page never disagrees with the AI's debt answer.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;

export const isOpenInvoice = (i: Invoice) => i.paymentStatus === "unpaid" || i.paymentStatus === "partial";

export interface CustomerInvoiceSummary {
  /** unpaid + partial, OLDEST first — the order to chase them in. */
  unpaid: Invoice[];
  /** fully paid, newest first. */
  paid: Invoice[];
  /** every invoice (including drafts and voids), newest first. */
  all: Invoice[];
  totalOwed: number;
  /** Date of the oldest unpaid/partial invoice, or null when nothing is owed. */
  oldestUnpaidDate: number | null;
  /** Sum of `total` over committed invoices (unpaid, partial, paid) — drafts and voids are not sales. */
  totalBilled: number;
  /** Sum of `amountPaid` over the same committed invoices. */
  totalPaid: number;
}

export function summarizeCustomerInvoices(invoices: Invoice[]): CustomerInvoiceSummary {
  const all = [...invoices].sort((a, b) => b.date - a.date || b.createdAt - a.createdAt);
  const unpaid = all.filter(isOpenInvoice).reverse();
  const paid = all.filter((i) => i.paymentStatus === "paid");
  const committed = all.filter((i) => isOpenInvoice(i) || i.paymentStatus === "paid");
  return {
    unpaid,
    paid,
    all,
    totalOwed: round2(unpaid.reduce((sum, i) => sum + i.balance, 0)),
    oldestUnpaidDate: unpaid.length ? unpaid[0].date : null,
    totalBilled: round2(committed.reduce((sum, i) => sum + i.total, 0)),
    totalPaid: round2(committed.reduce((sum, i) => sum + i.amountPaid, 0)),
  };
}

/** Whole days since `date` (0 for today or a future date). */
export function daysSince(date: number, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - date) / DAY_MS));
}

/** Owed per customer id, for the customers list. Invoices without a customerId are skipped (same as getCustomerDebt). */
export function owedByCustomer(invoices: Invoice[]): Map<string, number> {
  const owed = new Map<string, number>();
  for (const i of invoices) {
    if (!i.customerId || !isOpenInvoice(i)) continue;
    owed.set(i.customerId, (owed.get(i.customerId) ?? 0) + i.balance);
  }
  for (const [id, sum] of owed) owed.set(id, round2(sum));
  return owed;
}
