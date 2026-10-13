import { describe, expect, it } from "vitest";
import { allocatePaymentOldestFirst, type AllocatableInvoice } from "./paymentAllocation";

const inv = (id: string, date: number, balance: number, over: Partial<AllocatableInvoice> = {}): AllocatableInvoice => ({
  id,
  invoiceNumber: id,
  date,
  createdAt: date,
  balance,
  paymentStatus: "unpaid",
  ...over,
});

const sum = (ns: number[]) => Math.round(ns.reduce((s, n) => s + n, 0) * 100) / 100;

describe("allocatePaymentOldestFirst", () => {
  it("pays the oldest invoice first, whatever order they come in", () => {
    const r = allocatePaymentOldestFirst([inv("C", 3, 50), inv("A", 1, 100), inv("B", 2, 80)], 150);
    expect(r.allocations.map((a) => [a.invoiceId, a.amount, a.balanceAfter])).toEqual([
      ["A", 100, 0],
      ["B", 50, 30],
    ]);
    expect(r.leftover).toBe(0);
  });

  it("exact pay: every invoice fully paid, nothing left over", () => {
    const r = allocatePaymentOldestFirst([inv("A", 1, 100), inv("B", 2, 80.55)], 180.55);
    expect(r.allocations.every((a) => a.balanceAfter === 0)).toBe(true);
    expect(r.leftover).toBe(0);
  });

  it("partial pay: only the oldest is touched and stays partly owed", () => {
    const r = allocatePaymentOldestFirst([inv("A", 1, 100), inv("B", 2, 80)], 40);
    expect(r.allocations).toEqual([{ invoiceId: "A", invoiceNumber: "A", amount: 40, balanceBefore: 100, balanceAfter: 60 }]);
  });

  it("overpay: every invoice paid and the extra comes back as leftover (never lost)", () => {
    const r = allocatePaymentOldestFirst([inv("A", 1, 100), inv("B", 2, 80)], 200);
    expect(r.allocations.map((a) => a.amount)).toEqual([100, 80]);
    expect(r.leftover).toBe(20);
  });

  it("nothing owed: the whole payment is leftover", () => {
    expect(allocatePaymentOldestFirst([], 25)).toEqual({ allocations: [], leftover: 25 });
  });

  it("skips $0 open deliveries, drafts, voids and paid invoices", () => {
    const r = allocatePaymentOldestFirst(
      [
        inv("delivery0", 0, 0),
        inv("draft", 1, 50, { paymentStatus: "draft" }),
        inv("void", 1, 50, { paymentStatus: "void" }),
        inv("paid", 1, 0, { paymentStatus: "paid" }),
        inv("A", 5, 30, { paymentStatus: "partial" }),
      ],
      30
    );
    expect(r.allocations.map((a) => a.invoiceId)).toEqual(["A"]);
    expect(r.leftover).toBe(0);
  });

  it("same date: earlier created first, then lower invoice number", () => {
    const r = allocatePaymentOldestFirst([inv("2010", 1, 10, { createdAt: 5 }), inv("2002", 1, 10, { createdAt: 5 }), inv("2001", 1, 10, { createdAt: 9 })], 15);
    expect(r.allocations.map((a) => a.invoiceId)).toEqual(["2002", "2010"]);
  });

  it("never creates or loses a cent: allocated + leftover always equals the payment", () => {
    const invoices = [inv("A", 1, 0.1), inv("B", 2, 0.2), inv("C", 3, 33.33), inv("D", 4, 19.99)];
    for (const amount of [0.01, 0.3, 0.31, 33.62, 53.62, 53.63, 100.07]) {
      const r = allocatePaymentOldestFirst(invoices, amount);
      expect(sum([...r.allocations.map((a) => a.amount), r.leftover])).toBe(amount);
      for (const a of r.allocations) expect(sum([a.balanceBefore, -a.amount])).toBe(a.balanceAfter);
    }
  });
});
