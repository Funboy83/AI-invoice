import { describe, expect, it } from "vitest";
import { choicesFromCandidates, cleanChoices, collectLinks, isSafeChatHref, linksForToolResult, MAX_CHAT_CHOICES, MAX_CHAT_LINKS } from "./links";

const inv = (id: string, invoiceNumber: string) => ({ id, invoiceNumber, customerName: "Hoa" });

describe("linksForToolResult", () => {
  it("links a created or edited invoice to its page", () => {
    expect(linksForToolResult("createInvoiceDraft", {}, { status: "created", invoice: inv("abc", "2001") })).toEqual([
      { href: "/invoices/abc", label: "Mở invoice #2001" },
    ]);
    expect(linksForToolResult("recordPayment", {}, { status: "recorded", invoice: inv("x/y", "2002") })[0].href).toBe("/invoices/x%2Fy");
  });

  it("links a customer or product record", () => {
    expect(linksForToolResult("createCustomer", {}, { status: "created", customer: { id: "c1", name: "Chị Hoa" } })).toEqual([
      { href: "/customers?id=c1", label: "Khách: Chị Hoa" },
    ]);
    expect(linksForToolResult("getProduct", {}, { product: { id: "p1", name: "Milo" } })).toEqual([
      { href: "/products?id=p1", label: "Sản phẩm: Milo" },
    ]);
  });

  it("only links a search when there is exactly one hit", () => {
    expect(linksForToolResult("searchCustomer", { query: "hoa" }, { results: [{ id: "c1", name: "Hoa" }] })).toHaveLength(1);
    expect(linksForToolResult("searchCustomer", { query: "h" }, { results: [{ id: "c1" }, { id: "c2" }] })).toEqual([]);
  });

  it("links a customer's invoice list for debt and multi-invoice searches", () => {
    expect(linksForToolResult("getCustomerDebt", { customerId: "c1" }, { balance: 10, openInvoices: [inv("a", "1"), inv("b", "2")] })).toEqual([
      { href: "/invoices?customer=c1", label: "Invoice của khách này" },
    ]);
    expect(linksForToolResult("getUnpaidInvoices", {}, { results: [inv("a", "1")] })).toEqual([
      { href: "/invoices?status=unpaid", label: "Invoice chưa thanh toán" },
    ]);
  });

  it("returns nothing for errors, missing ids or unknown tools", () => {
    expect(linksForToolResult("createInvoiceDraft", {}, { status: "error", message: "x" })).toEqual([]);
    expect(linksForToolResult("getInvoice", {}, { invoice: { invoiceNumber: "1" } })).toEqual([]);
    expect(linksForToolResult("requestUserInput", {}, { status: "awaiting_user" })).toEqual([]);
    expect(linksForToolResult("getInvoice", {}, null)).toEqual([]);
  });
});

describe("collectLinks", () => {
  it("dedupes, puts the newest first and caps the count", () => {
    const a = { href: "/invoices/a", label: "A" };
    const b = { href: "/invoices/b", label: "B" };
    expect(collectLinks([[a], [b], [{ ...a, label: "A2" }]])).toEqual([{ href: "/invoices/a", label: "A2" }, b]);
    const many = Array.from({ length: 10 }, (_, i) => [{ href: `/invoices/${i}`, label: String(i) }]);
    expect(collectLinks(many)).toHaveLength(MAX_CHAT_LINKS);
  });
});

describe("isSafeChatHref", () => {
  it("allows only in-app list/detail pages", () => {
    expect(isSafeChatHref("/invoices/abc")).toBe(true);
    expect(isSafeChatHref("/customers?id=1")).toBe(true);
    expect(isSafeChatHref("/products")).toBe(true);
    expect(isSafeChatHref("https://evil.example")).toBe(false);
    expect(isSafeChatHref("//evil.example/invoices")).toBe(false);
    expect(isSafeChatHref("javascript:alert(1)")).toBe(false);
    expect(isSafeChatHref("/invoicesX")).toBe(false);
  });
});

describe("answer choices", () => {
  it("cleans the AI's options", () => {
    expect(cleanChoices([" Chị Hoa  Lee ", "chị hoa lee", 3, "", "Khách mới"])).toEqual(["Chị Hoa Lee", "Khách mới"]);
    expect(cleanChoices("x")).toEqual([]);
    expect(cleanChoices(Array.from({ length: 10 }, (_, i) => `c${i}`))).toHaveLength(MAX_CHAT_CHOICES);
  });

  it("turns needs_confirmation candidates into buttons", () => {
    expect(
      choicesFromCandidates({
        status: "needs_confirmation",
        candidates: [{ id: "1", name: "Hoa Lee", phone: "0909" }, { id: "2", name: "Hoa Nguyen" }, { id: "3" }],
      })
    ).toEqual(["Hoa Lee – 0909", "Hoa Nguyen"]);
    expect(choicesFromCandidates({ status: "created", candidates: [{ name: "x" }] })).toEqual([]);
  });
});
