import { ValidationError } from "./domainErrors";
import type { InvoiceLineItem, InvoiceStatus } from "./types";

/**
 * Pure invoice math and serialization, shared by the client-SDK store (browser reads/legacy writes) and the
 * Admin-SDK business store (server mutations), so both paths compute identical totals and apply Task A's
 * missing-field fix identically. No Firestore import here on purpose — keep this trivially testable.
 *
 * The validation/sanitization functions below (sanitizeInvoiceItems, assertFiniteAmount, assertPositiveAmount,
 * assertFiniteTotals) are called ONLY from src/lib/server/businessStore.ts — the shared boundary both the AI
 * tools (src/lib/ai/tools.ts) and the manual /api/business/* routes write through — never from src/lib/store.ts,
 * so Task A's client-SDK write path and its regression test are completely unaffected by this file's exports.
 */

/** Reasonable upper bound for any single money/quantity field — also keeps quantity*price from ever overflowing. */
export const MAX_FINANCIAL_VALUE = 1_000_000_000;

/**
 * Validates every line's quantity/price are finite, non-negative and bounded — never Infinity/NaN/negative, no
 * matter which caller (an AI tool or a manual route) produced them — and RECOMPUTES lineTotal from quantity*price
 * rather than trusting whatever the caller attached, so a wrong or forged lineTotal can never reach a stored
 * total. Exactly 0 for quantity and/or price is preserved (never rejected): that is how the AI marks a line
 * "incomplete" — missing information, not invalid information — and it must keep saving as a temp draft.
 */
export function sanitizeInvoiceItems(items: InvoiceLineItem[]): InvoiceLineItem[] {
  return items.map((item) => {
    const label = item.productName || "line item";
    if (!Number.isFinite(item.quantity) || item.quantity < 0 || item.quantity > MAX_FINANCIAL_VALUE) {
      throw new ValidationError(`Invalid quantity for ${label}.`);
    }
    if (!Number.isFinite(item.price) || item.price < 0 || item.price > MAX_FINANCIAL_VALUE) {
      throw new ValidationError(`Invalid price for ${label}.`);
    }
    return { ...item, lineTotal: Math.round(item.quantity * item.price * 100) / 100 };
  });
}

/** shipping/discount: finite and bounded. Sign is deliberately unrestricted — an existing, intentional looseness this does not change. */
export function assertFiniteAmount(value: number, field: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_FINANCIAL_VALUE) throw new ValidationError(`${field} must be a finite, reasonable amount.`);
}

/** A price/cost/default-shipping value: finite, bounded, and never negative — zero (free/no default) is fine. */
export function assertNonNegativeAmount(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > MAX_FINANCIAL_VALUE) throw new ValidationError(`${field} must be a non-negative amount.`);
}

/** A payment amount (or any other money value that must be strictly positive): finite, > 0, bounded. */
export function assertPositiveAmount(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_FINANCIAL_VALUE) throw new ValidationError(`${field} must be a positive amount.`);
}

/** After totals are computed, confirm they are still finite — inputs within bounds shouldn't overflow, but this is the backstop. */
export function assertFiniteTotals(subtotal: number, total: number): void {
  if (!Number.isFinite(subtotal) || !Number.isFinite(total)) throw new ValidationError("Computed totals are invalid.");
}

/** Firestore rejects undefined values, including optional fields inside item arrays (Task A). */
export function invoiceItemsForWrite(items: InvoiceLineItem[]): InvoiceLineItem[] {
  return items.map(({ productId, barcode, incomplete, ...required }) => ({
    ...required,
    ...(productId !== undefined ? { productId } : {}),
    ...(barcode !== undefined ? { barcode } : {}),
    ...(incomplete !== undefined ? { incomplete } : {}),
  }));
}

export function calcTotals(items: InvoiceLineItem[], shipping: number, discount: number) {
  const subtotal = Math.round(items.reduce((sum, li) => sum + li.lineTotal, 0) * 100) / 100;
  const total = Math.round((subtotal + shipping - discount) * 100) / 100;
  return { subtotal, total };
}

/** draft/void are manual states; otherwise status is derived from paid amount vs total. */
export function computePaymentStatus(total: number, amountPaid: number, manualStatus?: InvoiceStatus): InvoiceStatus {
  if (manualStatus === "void" || manualStatus === "draft") return manualStatus;
  if (amountPaid <= 0) return "unpaid";
  if (amountPaid >= total) return "paid";
  return "partial";
}
