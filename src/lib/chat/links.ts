/**
 * Shortcut buttons shown under an AI reply ("Mở invoice #2001", "Xem khách hàng"), so she can jump straight to the
 * right screen instead of digging through the menu. Links are derived on the server from the tool results themselves
 * (never from the model's text), so they always point at a record that really exists.
 */

export interface ChatLink {
  href: string;
  label: string;
}

/** Most buttons shown under one reply. */
export const MAX_CHAT_LINKS = 4;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function invoiceLink(v: unknown): ChatLink | null {
  const inv = obj(v);
  const id = str(inv?.id);
  if (!id) return null;
  const num = str(inv?.invoiceNumber);
  return { href: `/invoices/${encodeURIComponent(id)}`, label: num ? `Mở invoice #${num}` : "Mở invoice" };
}

function customerLink(v: unknown): ChatLink | null {
  const c = obj(v);
  const id = str(c?.id);
  if (!id) return null;
  const name = str(c?.name);
  return { href: `/customers?id=${encodeURIComponent(id)}`, label: name ? `Khách: ${name}` : "Xem khách hàng" };
}

function productLink(v: unknown): ChatLink | null {
  const p = obj(v);
  const id = str(p?.id);
  if (!id) return null;
  const name = str(p?.name);
  return { href: `/products/${encodeURIComponent(id)}`, label: name ? `Sản phẩm: ${name}` : "Xem sản phẩm" };
}

const customerInvoicesLink = (customerId: string): ChatLink => ({
  href: `/invoices?customer=${encodeURIComponent(customerId)}`,
  label: "Invoice của khách này",
});

/** Links for one tool call. `input` is the tool's arguments, `result` its parsed result. */
export function linksForToolResult(tool: string, input: unknown, result: unknown): ChatLink[] {
  const r = obj(result);
  if (!r) return [];
  const args = obj(input) ?? {};
  const results = Array.isArray(r.results) ? r.results : null;
  const out: (ChatLink | null)[] = [];

  switch (tool) {
    case "createInvoiceDraft":
    case "createDeliveryOrder":
    case "convertDelivery":
    case "getInvoice":
    case "addInvoiceItem":
    case "updateInvoiceItem":
    case "removeInvoiceItem":
    case "updateInvoice":
    case "finalizeInvoice":
    case "copyInvoice":
    case "recordPayment":
      out.push(invoiceLink(r.invoice));
      break;
    case "createCustomer":
    case "getCustomer":
    case "updateCustomer":
      out.push(customerLink(r.customer));
      break;
    case "createProduct":
    case "getProduct":
    case "updateProduct":
      out.push(productLink(r.product));
      break;
    case "searchCustomer":
      // Only a single clear hit is worth a button; a list of candidates means she still has to pick.
      if (results?.length === 1) out.push(customerLink(results[0]));
      break;
    case "searchProduct":
      if (results?.length === 1) out.push(productLink(results[0]));
      break;
    case "searchInvoices":
    case "getCustomerInvoices": {
      if (results?.length === 1) out.push(invoiceLink(results[0]));
      const customerId = str(args.customerId);
      if (results && results.length > 1 && customerId) out.push(customerInvoicesLink(customerId));
      else if (results && results.length > 1) out.push({ href: "/invoices", label: "Xem danh sách invoice" });
      break;
    }
    case "getCustomerDebt": {
      const open = Array.isArray(r.openInvoices) ? r.openInvoices : [];
      if (open.length === 1) out.push(invoiceLink(open[0]));
      const customerId = str(args.customerId);
      if (customerId) out.push(customerInvoicesLink(customerId));
      break;
    }
    case "getUnpaidInvoices":
      if (results && results.length > 0) out.push({ href: "/invoices?status=unpaid", label: "Invoice chưa thanh toán" });
      break;
    case "getDeliveries": {
      const list = Array.isArray(r.deliveries) ? r.deliveries : [];
      if (list.length === 1) out.push(invoiceLink(list[0]));
      if (list.length > 0) out.push({ href: "/invoices?tag=delivery", label: "Đơn giao hàng chưa chốt giá" });
      break;
    }
  }
  return out.filter((l): l is ChatLink => l !== null);
}

/** Merge links from several tool calls: the latest mention of a page wins its spot, duplicates are dropped. */
export function collectLinks(groups: ChatLink[][]): ChatLink[] {
  const byHref = new Map<string, ChatLink>();
  for (const group of groups) {
    for (const link of group) {
      byHref.delete(link.href);
      byHref.set(link.href, link);
    }
  }
  // Most recent first: what she just did is what she most likely wants to open.
  return [...byHref.values()].reverse().slice(0, MAX_CHAT_LINKS);
}

/** Only in-app pages may become buttons (guards against anything odd stored on a message). */
export function isSafeChatHref(href: unknown): href is string {
  return typeof href === "string" && /^\/(invoices|customers|products)(\/|\?|$)/.test(href) && !href.startsWith("//");
}

/* ------------------------------ answer choices ------------------------------ */

/** Most tap-to-answer buttons under one question. */
export const MAX_CHAT_CHOICES = 6;
const MAX_CHOICE_CHARS = 120;

/** Cleans the AI's `options` (or candidate labels): strings only, trimmed, no duplicates, capped. */
export function cleanChoices(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const c = v.replace(/\s+/g, " ").trim().slice(0, MAX_CHOICE_CHARS);
    if (!c || seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase());
    out.push(c);
    if (out.length === MAX_CHAT_CHOICES) break;
  }
  return out;
}

/**
 * Fallback when the AI asked "which one?" without giving options: the similar customers/products a tool just
 * returned (`needs_confirmation` → `candidates`) become the buttons, labelled by name plus phone when known.
 */
export function choicesFromCandidates(result: unknown): string[] {
  const r = obj(result);
  if (!r || r.status !== "needs_confirmation") return [];
  // A yes/edit confirmation (e.g. a delivery order preview) names its own answer buttons.
  if (Array.isArray(r.confirmChoices)) return cleanChoices(r.confirmChoices);
  if (!Array.isArray(r.candidates)) return [];
  return cleanChoices(
    r.candidates.map((c) => {
      const o = obj(c);
      const name = str(o?.name);
      if (!name) return null;
      const phone = str(o?.phone);
      return phone ? `${name} – ${phone}` : name;
    })
  );
}
