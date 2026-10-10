import { describe, expect, it } from "vitest";
import { ValidationError } from "@/lib/domainErrors";
import {
  requireFiniteNumber,
  requireMoney,
  requirePositive,
  requireInvoiceStatus,
  requireReason,
  requireName,
  requireManualLineItems,
  optionalOperationId,
} from "./businessValidation";

describe("requireFiniteNumber / requireMoney / requirePositive", () => {
  it("rejects NaN, Infinity, strings, booleans, null, undefined — 'range-correct' means finite and typed", () => {
    for (const bad of [NaN, Infinity, -Infinity, "5", true, null, undefined, {}]) {
      expect(() => requireFiniteNumber(bad, "Giá")).toThrow(ValidationError);
    }
  });

  it("requireMoney rejects negative amounts but allows zero", () => {
    expect(() => requireMoney(-0.01, "Giá")).toThrow(ValidationError);
    expect(requireMoney(0, "Giá")).toBe(0);
    expect(requireMoney(29.99, "Giá")).toBe(29.99);
  });

  it("requirePositive rejects zero and negative — for quantities and payment amounts a request must actually move something", () => {
    expect(() => requirePositive(0, "Số lượng")).toThrow(ValidationError);
    expect(() => requirePositive(-5, "Số lượng")).toThrow(ValidationError);
    expect(requirePositive(0.5, "Số lượng")).toBe(0.5);
  });

  it("rejects absurdly large numbers (defends totals from overflow-style abuse)", () => {
    expect(() => requireMoney(1e15, "Giá")).toThrow(ValidationError);
  });
});

describe("requireInvoiceStatus", () => {
  it("accepts only the five real statuses", () => {
    for (const s of ["draft", "unpaid", "partial", "paid", "void"]) expect(requireInvoiceStatus(s)).toBe(s);
  });
  it("rejects anything else, including case variants and injected values", () => {
    for (const bad of ["Draft", "UNPAID", "deleted", "", 1, null, { $ne: null }]) expect(() => requireInvoiceStatus(bad)).toThrow(ValidationError);
  });
});

describe("requireReason / requireName", () => {
  it("rejects empty/whitespace-only and non-string, trims valid input", () => {
    expect(() => requireReason("")).toThrow(ValidationError);
    expect(() => requireReason("   ")).toThrow(ValidationError);
    expect(() => requireReason(42)).toThrow(ValidationError);
    expect(requireReason("  Customer asked for a change  ")).toBe("Customer asked for a change");
  });
  it("rejects a reason/name over the length cap (abuse guard, not a business rule change)", () => {
    expect(() => requireReason("x".repeat(2001))).toThrow(ValidationError);
    expect(() => requireName("x".repeat(201), "Tên")).toThrow(ValidationError);
  });
});

describe("requireManualLineItems", () => {
  it("requires at least one item and rejects an empty array", () => {
    expect(() => requireManualLineItems([])).toThrow(ValidationError);
    expect(() => requireManualLineItems("not an array")).toThrow(ValidationError);
  });

  it("manual quantity must be POSITIVE — unlike the AI's incomplete-draft path, a manual line never silently saves as 0", () => {
    expect(() => requireManualLineItems([{ productName: "Milo", quantity: 0, price: 29 }])).toThrow(ValidationError);
    expect(() => requireManualLineItems([{ productName: "Milo", quantity: -1, price: 29 }])).toThrow(ValidationError);
  });

  it("rejects a negative price and computes lineTotal itself (never trusts a client-supplied lineTotal)", () => {
    expect(() => requireManualLineItems([{ productName: "Milo", quantity: 2, price: -1 }])).toThrow(ValidationError);
    const [item] = requireManualLineItems([{ productName: "Milo", quantity: 2, price: 10, lineTotal: 999999 }]);
    expect(item.lineTotal).toBe(20); // the forged lineTotal is ignored; recomputed from quantity*price
  });

  it("rejects an item missing a product name", () => {
    expect(() => requireManualLineItems([{ quantity: 1, price: 1 }])).toThrow(ValidationError);
  });

  it("caps the number of items to guard against pathological requests", () => {
    const items = Array.from({ length: 201 }, () => ({ productName: "x", quantity: 1, price: 1 }));
    expect(() => requireManualLineItems(items)).toThrow(ValidationError);
  });

  it("passes through a valid productId, defaults unit to 'unit' when absent", () => {
    const [item] = requireManualLineItems([{ productId: "p1", productName: "Milo", quantity: 2, price: 10 }]);
    expect(item).toMatchObject({ productId: "p1", unit: "unit", lineTotal: 20 });
  });
});

describe("optionalOperationId", () => {
  it("accepts a well-formed client-supplied idempotency key, or none at all", () => {
    expect(optionalOperationId(undefined)).toBeUndefined();
    expect(optionalOperationId("abcdefgh-1234")).toBe("abcdefgh-1234");
  });
  it("rejects a malformed key rather than silently ignoring it (would defeat duplicate protection)", () => {
    for (const bad of ["short", "has spaces here", "x".repeat(81), 123]) expect(() => optionalOperationId(bad)).toThrow(ValidationError);
  });
});
