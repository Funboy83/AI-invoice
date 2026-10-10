import { ValidationError } from "@/lib/domainErrors";
import type { InvoiceLineItem, InvoiceStatus } from "@/lib/types";

/**
 * Server-side validation for the manual business API routes. The client already guards most of this (see the page
 * components), but every check here exists because the CLIENT check is not trustworthy — these run again, on the
 * server, against whatever the request actually contains, and reject with no partial write on failure.
 */

const MAX_NAME_LEN = 200;
const MAX_TEXT_LEN = 4000;
const MAX_REASON_LEN = 2000;
const STATUSES: readonly InvoiceStatus[] = ["draft", "unpaid", "partial", "paid", "void"];

export function requireString(v: unknown, field: string, maxLen = MAX_TEXT_LEN): string {
  if (typeof v !== "string") throw new ValidationError(`${field} phải là văn bản.`);
  const trimmed = v.trim();
  if (trimmed.length === 0) throw new ValidationError(`${field} không được để trống.`);
  if (trimmed.length > maxLen) throw new ValidationError(`${field} quá dài (tối đa ${maxLen} ký tự).`);
  return trimmed;
}

export function optionalString(v: unknown, field: string, maxLen = MAX_TEXT_LEN): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ValidationError(`${field} phải là văn bản.`);
  if (v.length > maxLen) throw new ValidationError(`${field} quá dài (tối đa ${maxLen} ký tự).`);
  return v;
}

export function requireName(v: unknown, field: string): string {
  return requireString(v, field, MAX_NAME_LEN);
}

export function requireReason(v: unknown): string {
  return requireString(v, "Lý do chỉnh sửa", MAX_REASON_LEN);
}

/** Finite number, optionally bounded. Rejects NaN/Infinity/strings/booleans — "range-correct" money and quantities. */
export function requireFiniteNumber(v: unknown, field: string, opts: { min?: number; max?: number } = {}): number {
  const n = typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n)) throw new ValidationError(`${field} phải là một số hợp lệ.`);
  if (opts.min !== undefined && n < opts.min) throw new ValidationError(`${field} phải lớn hơn hoặc bằng ${opts.min}.`);
  if (opts.max !== undefined && n > opts.max) throw new ValidationError(`${field} không được vượt quá ${opts.max}.`);
  return n;
}

export function optionalFiniteNumber(v: unknown, field: string, opts: { min?: number; max?: number } = {}): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return requireFiniteNumber(v, field, opts);
}

/** Money: finite, non-negative. Used for prices, costs, default prices — never a payment amount (that must be > 0). */
export function requireMoney(v: unknown, field: string): number {
  return requireFiniteNumber(v, field, { min: 0, max: 1_000_000_000 });
}

export function optionalMoney(v: unknown, field: string): number | undefined {
  return optionalFiniteNumber(v, field, { min: 0, max: 1_000_000_000 });
}

/** Stock quantity: finite, non-negative. Omit entirely to leave a product's stock untracked. */
export function optionalQuantity(v: unknown, field: string): number | undefined {
  return optionalFiniteNumber(v, field, { min: 0, max: 1_000_000_000 });
}

/** A payment or manually-entered line quantity must be strictly positive — never zero, never negative. */
export function requirePositive(v: unknown, field: string): number {
  return requireFiniteNumber(v, field, { min: 1e-9, max: 1_000_000_000 });
}

export function requireInvoiceStatus(v: unknown): InvoiceStatus {
  if (typeof v !== "string" || !STATUSES.includes(v as InvoiceStatus)) {
    throw new ValidationError(`Trạng thái không hợp lệ (phải là một trong: ${STATUSES.join(", ")}).`);
  }
  return v as InvoiceStatus;
}

export function optionalInvoiceStatus(v: unknown): InvoiceStatus | undefined {
  if (v === undefined || v === null) return undefined;
  return requireInvoiceStatus(v);
}

export function optionalStringArray(v: unknown, field: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new ValidationError(`${field} phải là danh sách văn bản.`);
  return v as string[];
}

/**
 * One manually-entered invoice line for a NEW invoice: quantity must be POSITIVE. (Unlike the AI's incomplete-draft
 * path, a brand-new manual invoice is never allowed to silently save a quantity-0 line — that path is specific to
 * AI parsing uncertain order text and is untouched by this validator.) `lineTotal` is always recomputed from
 * quantity*price here — a client-supplied lineTotal is never trusted.
 */
export function requireManualLineItem(raw: unknown, index: number): InvoiceLineItem {
  if (typeof raw !== "object" || raw === null) throw new ValidationError(`Dòng hàng #${index + 1} không hợp lệ.`);
  const r = raw as Record<string, unknown>;
  const productName = requireName(r.productName, `Tên sản phẩm (dòng ${index + 1})`);
  const quantity = requirePositive(r.quantity, `Số lượng (dòng ${index + 1})`);
  const price = requireMoney(r.price, `Giá (dòng ${index + 1})`);
  const unit = typeof r.unit === "string" && r.unit.trim() ? r.unit.trim() : "unit";
  const productId = typeof r.productId === "string" && r.productId ? r.productId : undefined;
  const lineTotal = Math.round(quantity * price * 100) / 100;
  return { productId, productName, quantity, unit, price, lineTotal };
}

export function requireManualLineItems(v: unknown): InvoiceLineItem[] {
  if (!Array.isArray(v) || v.length === 0) throw new ValidationError("Cần ít nhất một dòng hàng.");
  if (v.length > 200) throw new ValidationError("Quá nhiều dòng hàng trong một invoice.");
  return v.map((raw, i) => requireManualLineItem(raw, i));
}

/**
 * One line of an EXISTING invoice being edited: quantity may be ZERO (but never negative). This intentionally
 * differs from requireManualLineItem — the invoice detail page's own edit form has always allowed quantity 0
 * (its number input has no `min`), because editing is also how a person manually finishes an AI-created
 * "incomplete temp draft" one item at a time; rejecting 0 here would make it impossible to save partial progress
 * while other lines are still being fixed. `productId` IS required (the existing edit form already refuses to
 * submit with any line unmatched to a product — this enforces that same rule server-side). `incomplete`/`barcode`
 * pass through unchanged when present, exactly as the client already does; this validator never invents or
 * clears `incomplete` itself.
 */
export function requireEditLineItem(raw: unknown, index: number): InvoiceLineItem {
  if (typeof raw !== "object" || raw === null) throw new ValidationError(`Dòng hàng #${index + 1} không hợp lệ.`);
  const r = raw as Record<string, unknown>;
  const productName = requireName(r.productName, `Tên sản phẩm (dòng ${index + 1})`);
  const productId = typeof r.productId === "string" ? r.productId.trim() : "";
  if (!productId) throw new ValidationError(`Chọn hoặc thêm sản phẩm cho dòng ${index + 1} trước khi lưu.`);
  const quantity = requireFiniteNumber(r.quantity, `Số lượng (dòng ${index + 1})`, { min: 0, max: 1_000_000_000 });
  const price = requireMoney(r.price, `Giá (dòng ${index + 1})`);
  const unit = typeof r.unit === "string" && r.unit.trim() ? r.unit.trim() : "unit";
  const lineTotal = Math.round(quantity * price * 100) / 100;
  const barcode = typeof r.barcode === "string" ? r.barcode : undefined;
  const incomplete = typeof r.incomplete === "boolean" ? r.incomplete : undefined;
  return { productId, productName, quantity, unit, price, lineTotal, barcode, incomplete };
}

export function requireEditLineItems(v: unknown): InvoiceLineItem[] {
  if (!Array.isArray(v) || v.length === 0) throw new ValidationError("Cần ít nhất một dòng hàng.");
  if (v.length > 200) throw new ValidationError("Quá nhiều dòng hàng trong một invoice.");
  return v.map((raw, i) => requireEditLineItem(raw, i));
}

/** A client-supplied idempotency key for one mutation attempt (mirrors the chat requestId pattern). Optional. */
export function optionalOperationId(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(v)) throw new ValidationError("operationId không hợp lệ.");
  return v;
}
