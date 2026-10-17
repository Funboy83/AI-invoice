import type { Invoice } from "./types";

/**
 * "Phân bổ vào hóa đơn": splits one customer payment across that customer's open invoices, OLDEST first. Pure (no
 * Firestore) so the server (recordCustomerPayment in server/businessStore.ts, the only place that writes) and the
 * customer page's live preview run the exact same rule. All math is done in whole cents so splitting never
 * creates or loses a cent: the allocations always add up to the payment minus the leftover.
 *
 * Only unpaid/partial invoices with something still owed (balance > 0) receive money — a $0 open delivery, a
 * draft, a void or a paid invoice is skipped. Whatever is left after every open invoice is paid in full is
 * returned as `leftover` (the caller keeps it as customer credit, never drops it).
 */

export type AllocatableInvoice = Pick<Invoice, "id" | "invoiceNumber" | "date" | "createdAt" | "balance" | "paymentStatus">;

export interface PaymentAllocation {
  invoiceId: string;
  invoiceNumber: string;
  /** Amount of this payment that goes to the invoice. */
  amount: number;
  /** What the invoice still owed before this payment. */
  balanceBefore: number;
  /** What it still owes after (0 when fully paid). */
  balanceAfter: number;
}

export interface AllocationResult {
  allocations: PaymentAllocation[];
  /** Part of the payment no open invoice needed — kept as customer credit. */
  leftover: number;
}

const cents = (n: number) => Math.round(n * 100);
const dollars = (c: number) => c / 100;

/** Oldest first: invoice date, then creation time, then invoice number (numeric when both are numbers). */
export function compareOldestFirst(a: AllocatableInvoice, b: AllocatableInvoice): number {
  return a.date - b.date || a.createdAt - b.createdAt || a.invoiceNumber.localeCompare(b.invoiceNumber, undefined, { numeric: true });
}

export function canReceivePayment(i: AllocatableInvoice): boolean {
  return (i.paymentStatus === "unpaid" || i.paymentStatus === "partial") && cents(i.balance) > 0;
}

export function allocatePaymentOldestFirst(invoices: AllocatableInvoice[], amount: number): AllocationResult {
  let remaining = cents(amount);
  const allocations: PaymentAllocation[] = [];
  for (const inv of invoices.filter(canReceivePayment).sort(compareOldestFirst)) {
    if (remaining <= 0) break;
    const owed = cents(inv.balance);
    const take = Math.min(owed, remaining);
    remaining -= take;
    allocations.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      amount: dollars(take),
      balanceBefore: dollars(owed),
      balanceAfter: dollars(owed - take),
    });
  }
  return { allocations, leftover: dollars(Math.max(0, remaining)) };
}
