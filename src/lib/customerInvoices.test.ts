import { describe, expect, it } from "vitest";
import { daysSince, owedByCustomer, summarizeCustomerInvoices } from "./customerInvoices";
import type { Invoice, InvoiceStatus } from "./types";

const DAY = 24 * 60 * 60 * 1000;

function inv(id: string, status: InvoiceStatus, total: number, amountPaid: number, date: number, customerId = "c1"): Invoice {
  return {
    id,
    invoiceNumber: id,
    date,
    customerId,
    customerName: "Chị Hoa",
    items: [],
    shipping: 0,
    discount: 0,
    subtotal: total,
    total,
    amountPaid,
    balance: Math.round((total - amountPaid) * 100) / 100,
    paymentStatus: status,
    createdAt: date,
    updatedAt: date,
    createdBy: "user",
  };
}

describe("summarizeCustomerInvoices", () => {
  const invoices = [
    inv("a", "paid", 100, 100, 1 * DAY),
    inv("b", "unpaid", 50.1, 0, 5 * DAY),
    inv("c", "partial", 80, 30.2, 3 * DAY),
    inv("d", "draft", 999, 0, 6 * DAY),
    inv("e", "void", 777, 0, 7 * DAY),
    inv("f", "paid", 20, 20, 8 * DAY),
  ];

  it("splits unpaid (oldest first) from paid (newest first)", () => {
    const s = summarizeCustomerInvoices(invoices);
    expect(s.unpaid.map((i) => i.id)).toEqual(["c", "b"]);
    expect(s.paid.map((i) => i.id)).toEqual(["f", "a"]);
    expect(s.all.map((i) => i.id)).toEqual(["f", "e", "d", "b", "c", "a"]);
  });

  it("owed = sum of unpaid/partial balances, rounded to cents; drafts and voids never count", () => {
    const s = summarizeCustomerInvoices(invoices);
    expect(s.totalOwed).toBe(99.9); // 50.10 + 49.80
    expect(s.oldestUnpaidDate).toBe(3 * DAY);
    expect(s.totalBilled).toBe(250.1);
    expect(s.totalPaid).toBe(150.2);
  });

  it("nothing owed when every invoice is paid", () => {
    const s = summarizeCustomerInvoices([inv("a", "paid", 10, 10, DAY)]);
    expect(s.totalOwed).toBe(0);
    expect(s.oldestUnpaidDate).toBeNull();
    expect(s.unpaid).toEqual([]);
  });
});

describe("owedByCustomer", () => {
  it("adds up open balances per customer and skips invoices with no customerId", () => {
    const owed = owedByCustomer([
      inv("a", "unpaid", 10.1, 0, DAY, "c1"),
      inv("b", "partial", 10, 4.9, DAY, "c1"),
      inv("c", "paid", 10, 10, DAY, "c2"),
      { ...inv("d", "unpaid", 5, 0, DAY), customerId: undefined },
    ]);
    expect(owed.get("c1")).toBe(15.2);
    expect(owed.has("c2")).toBe(false);
    expect(owed.size).toBe(1);
  });
});

describe("daysSince", () => {
  it("counts whole days and never goes negative", () => {
    expect(daysSince(0, 3.5 * DAY)).toBe(3);
    expect(daysSince(10 * DAY, 0)).toBe(0);
  });
});
