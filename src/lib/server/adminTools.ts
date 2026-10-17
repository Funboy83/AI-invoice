import { findSimilarWithAliases, normalizeVN } from "@/lib/similarity";
import { DomainError, NotFoundError } from "@/lib/domainErrors";
import { assertNonNegativeAmount, assertPositiveAmount, computePaymentStatus } from "@/lib/invoiceMath";
import { allocatePaymentOldestFirst, canReceivePayment, compareOldestFirst } from "@/lib/paymentAllocation";
import { owedByCustomer, statementOwed, statementTotals, isStatementInvoice, daysSince } from "@/lib/customerInvoices";
import { isInvoiceIncomplete, isOpenDelivery, purchaseOwed, type Invoice, type InvoicePrintInfo, type Product, type Purchase, type Vendor } from "@/lib/types";
import { matchProduct, resolveCustomerMatch } from "@/lib/ai/tools";
import {
  getAllCustomers,
  getAllInvoices,
  getAllProducts,
  getCustomerById,
  getCustomInvoiceDefaults,
  getInvoice,
  getInvoiceByNumber,
  getInvoiceLogs,
  getInvoicePrintInfo,
  getInvoicesForCustomer,
  getPaymentsForInvoice,
  getPaymentById,
  changePayment,
  recordCustomerPayment,
  saveInvoicePrintInfo,
} from "./businessStore";
import {
  createPurchase,
  createVendor,
  findVendorInvoiceClash,
  getAllPurchases,
  getAllVendors,
  getPaymentsForPurchase,
  getPurchase,
  getPurchasesForVendor,
  getVendor,
  recordVendorPayment,
  updatePurchaseInfo,
  updateVendor,
  voidPurchase,
} from "./purchaseStore";
import { requirePrintInfo } from "./businessValidation";

/**
 * Tools the OUTSIDE AI apps (API / MCP, see externalApi.ts) need on top of the chat's tools (src/lib/ai/tools.ts) so
 * they can do everything the app's own pages do: the "Buy from vendor" side (vendors, purchases, vendor payments,
 * cancelling a purchase), the invoice list and dashboard numbers, an invoice's history, the Custom Invoice print
 * information, and the customer statement behind "Payment request". The in-app chat does not get these.
 *
 * Every write here only calls the SAME store functions the app's pages call (purchaseStore.ts, businessStore.ts), so
 * their rules still apply: totals computed on the server, no paying more than is owed, no duplicate vendor invoice
 * number, one transaction with the idempotency ledger. Each write first runs as a preview (ctx.previewOnly) that
 * checks everything and returns what WOULD happen plus `pinnedArgs`; externalApi.ts saves exactly those pinned args
 * after the person confirms. Nothing here deletes anything: "cancel" marks a purchase cancelled, like the app.
 */

type Args = Record<string, unknown>;
export interface AdminToolContext {
  operationId?: string;
  previewOnly?: boolean;
}

export interface AdminToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  readOnly: boolean;
}

const str = { type: "string" };
const num = { type: "number" };
const bool = { type: "boolean" };
const dateStr = (description: string) => ({ type: "string", description: `${description} As YYYY-MM-DD.` });

export const adminToolDefinitions: AdminToolDefinition[] = [
  /* ------------------------------ reads ------------------------------ */
  {
    name: "getStoreSummary",
    description:
      "The dashboard numbers: how many invoices, revenue (finished invoices), total customers owe, open deliveries, drafts still missing a quantity or price, number of products and customers, and the total the store owes its vendors.",
    input_schema: { type: "object", properties: {} },
    readOnly: true,
  },
  {
    name: "listInvoices",
    description:
      "The invoice list with filters, like the app's Invoices page: a date range (the invoice date, store's local day), one customer, a status ('open' = unpaid + partial), or only open delivery orders. Returns the matching invoices (newest first) and their totals (void invoices are listed but not counted in the money totals).",
    input_schema: {
      type: "object",
      properties: {
        dateFrom: dateStr("First day, inclusive."),
        dateTo: dateStr("Last day, inclusive. Same as dateFrom for one day."),
        customerId: str,
        status: { type: "string", enum: ["draft", "unpaid", "partial", "paid", "void", "open"] },
        deliveryOnly: { type: "boolean", description: "Only delivery orders still waiting for their final prices." },
        limit: { type: "number", description: "Max invoices to list (default 50). Totals always cover every match." },
      },
    },
    readOnly: true,
  },
  {
    name: "getInvoiceHistory",
    description: "An invoice's permanent audit log (every create, edit, payment and void, with who and why) and its payments.",
    input_schema: { type: "object", properties: { invoiceId: str, invoiceNumber: str } },
    readOnly: true,
  },
  {
    name: "getPaymentRequest",
    description:
      "The customer statement behind the customer page's 'Payment request' button: the customer's finished invoices (oldest first) with total, paid and still owed on each, and the statement totals. By default it holds every unpaid/partial invoice, which equals what the customer owes. Pass invoiceIds to pick exact invoices, or include='all' to add paid ones. Returns the link to open and print it in the app.",
    input_schema: {
      type: "object",
      properties: {
        customerId: str,
        invoiceIds: { type: "array", items: str },
        include: { type: "string", enum: ["open", "all"] },
      },
      required: ["customerId"],
    },
    readOnly: true,
  },
  {
    name: "getCustomInvoice",
    description:
      "The Custom Invoice (reprint) information for an invoice: template, company block, bill-to, ship-to, dates, P.O. #, notes and terms. When nothing is saved yet it returns what the app would pre-fill. Items and money always come from the invoice itself. Returns the link to print it.",
    input_schema: { type: "object", properties: { invoiceId: str, invoiceNumber: str } },
    readOnly: true,
  },
  {
    name: "listVendors",
    description: "All vendors (suppliers) with what the store still owes each one (unpaid + partly paid purchases).",
    input_schema: { type: "object", properties: { includeInactive: bool } },
    readOnly: true,
  },
  {
    name: "searchVendor",
    description: "Find a vendor by name (accent-insensitive, typo-tolerant). Use before creating a vendor or a purchase.",
    input_schema: { type: "object", properties: { query: str }, required: ["query"] },
    readOnly: true,
  },
  {
    name: "getVendor",
    description: "One vendor's details, what the store owes them, and all their purchases (newest first).",
    input_schema: { type: "object", properties: { vendorId: str }, required: ["vendorId"] },
    readOnly: true,
  },
  {
    name: "searchPurchases",
    description:
      "Search purchases (buying from vendors) like the app's Purchases page: text matches the vendor's invoice #, our PO #, the vendor name, products and notes. Filter by vendor, status ('open' = unpaid + partly paid) and date range. Returns purchases (newest first) and totals.",
    input_schema: {
      type: "object",
      properties: {
        query: str,
        vendorId: str,
        status: { type: "string", enum: ["unpaid", "partial", "paid", "void", "open"] },
        dateFrom: dateStr("First day, inclusive."),
        dateTo: dateStr("Last day, inclusive."),
        limit: num,
      },
    },
    readOnly: true,
  },
  {
    name: "getPurchase",
    description: "One purchase (by id or PO number like PO-1001) with its items, money and the payments made to the vendor for it.",
    input_schema: { type: "object", properties: { purchaseId: str, purchaseNumber: str } },
    readOnly: true,
  },

  /* ----------------------- writes (preview → confirmAction) ----------------------- */
  {
    name: "createPurchase",
    description:
      "Save a new purchase from a vendor (Buy from vendor → New purchase). Saving adds each item's quantity to the product's stock (a product not counted yet starts being counted), and by default also sets each product's cost to the cost paid (updateCost=false to keep costs). Give the vendor (vendorId, or vendorName to match), the vendor's invoice/receipt number, and items with product (productId, or productName to match), quantity and cost per unit (USD). A missing cost falls back to the product's saved cost. paidNow records money paid right away (payInFull=true pays the whole total); it can never be more than the total. The same vendor invoice # can't be saved twice for one vendor. Products must already exist: if one isn't found, offer createProduct first.",
    input_schema: {
      type: "object",
      properties: {
        vendorId: str,
        vendorName: str,
        vendorInvoiceNumber: { type: "string", description: "The number on the vendor's invoice or receipt." },
        date: dateStr("Purchase date; defaults to today."),
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { productId: str, productName: str, quantity: num, cost: { type: "number", description: "USD per unit." }, unit: str },
          },
        },
        shipping: { type: "number", description: "Shipping or other fees the vendor charged." },
        discount: num,
        notes: str,
        updateCost: { type: "boolean", description: "Also set each product's cost to the cost paid here. Default true, like the app." },
        paidNow: { type: "number", description: "Paid to the vendor right away. Default 0 (all still owed)." },
        payInFull: { type: "boolean", description: "Paid the whole total right away." },
        payMethod: str,
      },
      required: ["items"],
    },
    readOnly: false,
  },
  {
    name: "recordVendorPayment",
    description: "Record money paid to a vendor for one purchase. Never more than what is still owed on it; not on a cancelled purchase.",
    input_schema: {
      type: "object",
      properties: { purchaseId: str, purchaseNumber: str, amount: num, method: str, note: str },
      required: ["amount"],
    },
    readOnly: false,
  },
  {
    name: "updatePurchaseInfo",
    description: "Fix a purchase's look-up details only: the vendor invoice #, the date or the notes. Items, money and stock can't be changed (cancel and re-enter the purchase instead).",
    input_schema: {
      type: "object",
      properties: { purchaseId: str, purchaseNumber: str, vendorInvoiceNumber: str, date: dateStr("New date."), notes: str },
    },
    readOnly: false,
  },
  {
    name: "cancelPurchase",
    description:
      "Cancel a purchase entered by mistake (the app's Cancel purchase): exactly the quantities it added are taken back out of stock, payments recorded on it are marked voided, and it no longer counts as owed. The purchase is kept, marked Cancelled; nothing is deleted. Product costs are not changed back.",
    input_schema: { type: "object", properties: { purchaseId: str, purchaseNumber: str } },
    readOnly: false,
  },
  {
    name: "createVendor",
    description: "Add a new vendor (supplier). Search first with searchVendor; if a similar vendor exists, the preview warns.",
    input_schema: {
      type: "object",
      properties: { name: str, contactName: str, phone: str, email: str, address: str, notes: str },
      required: ["name"],
    },
    readOnly: false,
  },
  {
    name: "updateVendor",
    description: "Change a vendor's name, contact name, phone, email, address or notes. Past purchases keep the vendor name they were saved with.",
    input_schema: {
      type: "object",
      properties: { vendorId: str, name: str, contactName: str, phone: str, email: str, address: str, notes: str },
      required: ["vendorId"],
    },
    readOnly: false,
  },
  {
    name: "recordCustomerPayment",
    description:
      "The customer page's Record payment: one amount from a customer, applied to their unpaid invoices OLDEST FIRST (like KiotViet's 'Phân bổ vào hóa đơn'). The preview shows every open invoice with what it owes and how much of the money goes to it. Never more than the customer owes in total (outside apps can't create credit). Give customerId (or customerName), amount, and optionally method (Cash, Check, Zelle, Card, Bank transfer, Other), note and date (YYYY-MM-DD, today or earlier).",
    input_schema: {
      type: "object",
      properties: { customerId: str, customerName: str, amount: num, method: str, note: str, date: dateStr("Day the money was received (default today).") },
      required: ["amount"],
    },
    readOnly: false,
  },
  {
    name: "adjustCustomerDebt",
    description:
      "The customer page's Adjust debt: lower what a customer owes WITHOUT counting it as money received (e.g. forgiving a small amount). Applied oldest invoice first, a reason is required, never more than they owe. To fix a payment entered with the wrong amount use changePayment instead.",
    input_schema: {
      type: "object",
      properties: { customerId: str, customerName: str, amount: num, reason: str },
      required: ["amount", "reason"],
    },
    readOnly: false,
  },
  {
    name: "changePayment",
    description:
      "Fix a customer payment or debt adjustment (Payment history > Fix): action 'edit' sets the correct amount, action 'cancel' takes it back (kept, marked cancelled; never deleted). A reason is required. The invoice's balance and Paid/Partial/Unpaid status are recalculated; the preview shows them before and after. Find the paymentId with searchPayments (customerId or invoiceId). Refused if it would pay an invoice beyond its total or if the payment is already cancelled.",
    input_schema: {
      type: "object",
      properties: { paymentId: str, action: { type: "string", enum: ["edit", "cancel"] }, amount: { type: "number", description: "The correct amount (edit only)." }, reason: str },
      required: ["paymentId", "action", "reason"],
    },
    readOnly: false,
  },
  {
    name: "saveCustomInvoice",
    description:
      "Save the Custom Invoice (reprint) information for an invoice. Pass only what changes; the rest stays as saved (or as the app would pre-fill). template is 'professional' or 'simple'. from/shipTo are {name, address, phone, email?}; billTo is {address, phone}. Dates are YYYY-MM-DD ('' hides one). This never changes the invoice's customer, items, prices, totals or debt. The company block and terms are remembered for the next Custom Invoice.",
    input_schema: {
      type: "object",
      properties: {
        invoiceId: str,
        invoiceNumber: str,
        template: { type: "string", enum: ["professional", "simple"] },
        from: { type: "object", properties: { name: str, address: str, phone: str, email: str } },
        billTo: { type: "object", properties: { address: str, phone: str } },
        shipTo: { type: "object", properties: { name: str, address: str, phone: str } },
        date: str,
        dueDate: str,
        deliveryDate: str,
        po: str,
        notes: str,
        terms: str,
      },
    },
    readOnly: false,
  },
];

export const adminToolNames: ReadonlySet<string> = new Set(adminToolDefinitions.map((t) => t.name));

/* ------------------------------ helpers ------------------------------ */

const r2 = (n: number) => Math.round(n * 100) / 100;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** The store's calendar day for a timestamp, "YYYY-MM-DD". The store is in California unless STORE_TIME_ZONE says otherwise. */
export function storeDateKey(ms: number = Date.now()): string {
  const timeZone = process.env.STORE_TIME_ZONE || "America/Los_Angeles";
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

function dateArg(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).trim();
  if (!DATE_KEY.test(s)) throw new DomainError(`${field} must be a date like 2026-10-17.`);
  return s;
}

const inRange = (key: string, from?: string, to?: string) => (!from || key >= from) && (!to || key <= to);

const invoiceSummary = (i: Invoice) => ({
  id: i.id,
  invoiceNumber: i.invoiceNumber,
  date: storeDateKey(i.date),
  customerId: i.customerId,
  customerName: i.customerName,
  status: i.paymentStatus,
  ...(i.delivery ? { delivery: i.delivery.status } : {}),
  total: i.total,
  amountPaid: i.amountPaid,
  balance: i.balance,
});

const purchaseSummary = (p: Purchase) => ({
  id: p.id,
  purchaseNumber: p.purchaseNumber,
  vendorId: p.vendorId,
  vendorName: p.vendorName,
  vendorInvoiceNumber: p.vendorInvoiceNumber,
  date: p.dateKey,
  status: p.paymentStatus,
  total: p.total,
  amountPaid: p.amountPaid,
  balance: p.balance,
  owed: purchaseOwed(p),
  items: p.items.map((l) => ({ productName: l.productName, quantity: l.quantity, unit: l.unit, cost: l.cost })),
});

async function invoiceFromArgs(args: Args): Promise<Invoice> {
  const invoice = args.invoiceId ? await getInvoice(String(args.invoiceId)) : args.invoiceNumber ? await getInvoiceByNumber(String(args.invoiceNumber)) : null;
  if (!invoice) throw new NotFoundError("Invoice not found. Give its invoiceId or invoiceNumber.");
  return invoice;
}

async function customerFromArgs(args: Args) {
  if (args.customerId) {
    const c = await getCustomerById(String(args.customerId));
    if (!c) throw new NotFoundError("Customer not found.");
    return c;
  }
  if (!args.customerName) throw new DomainError("Give customerId or customerName.");
  const m = await resolveCustomerMatch(String(args.customerName));
  if (m.status === "match") return m.customer;
  if (m.status === "ambiguous") throw new DomainError(`Which customer? ${m.candidates.map((c) => `${c.name} (customerId ${c.id})`).join(", ")}. Call again with customerId.`);
  throw new NotFoundError(`No customer named "${args.customerName}".`);
}

async function purchaseFromArgs(args: Args): Promise<Purchase> {
  let purchase: Purchase | null = null;
  if (args.purchaseId) purchase = await getPurchase(String(args.purchaseId));
  else if (args.purchaseNumber) {
    const wanted = String(args.purchaseNumber).replace(/\s+/g, "").toUpperCase();
    purchase = (await getAllPurchases()).find((p) => p.purchaseNumber.toUpperCase() === wanted || p.purchaseNumber.toUpperCase() === `PO-${wanted}`) ?? null;
  }
  if (!purchase) throw new NotFoundError("Purchase not found. Give its purchaseId or PO number (e.g. PO-1001).");
  return purchase;
}

const purchaseLink = (p: Purchase) => `/purchases/${p.id}`;

type VendorMatch = { status: "match"; vendor: Vendor } | { status: "ambiguous"; candidates: { id: string; name: string }[] } | { status: "not_found" };

function matchVendor(query: string, vendors: Vendor[]): VendorMatch {
  const q = normalizeVN(query);
  const exact = vendors.filter((v) => normalizeVN(v.name) === q);
  if (exact.length === 1) return { status: "match", vendor: exact[0] };
  const matches = findSimilarWithAliases(query, vendors, (v) => v.name, () => [], 0.55);
  if (exact.length === 0 && matches.length === 1 && matches[0].score >= 0.82) return { status: "match", vendor: matches[0].item };
  if (exact.length === 0 && matches.length === 0) return { status: "not_found" };
  return { status: "ambiguous", candidates: (exact.length ? exact : matches.slice(0, 5).map((m) => m.item)).map((v) => ({ id: v.id, name: v.name })) };
}

function textMatches(query: string, fields: (string | undefined)[]): boolean {
  const q = normalizeVN(query);
  if (!q) return true;
  const compact = q.replace(/\s+/g, "");
  return fields.some((f) => {
    const n = normalizeVN(f ?? "");
    return n.includes(q) || n.replace(/\s+/g, "").includes(compact);
  });
}

function optText(v: unknown, field: string, max = 2000): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  if (s.length > max) throw new DomainError(`${field} is too long.`);
  return s;
}

/* ------------------------------ runner ------------------------------ */

/**
 * Runs one admin tool. Business-rule failures come back as `error`/`not_found` results (like executeTool); anything
 * else (database trouble) is rethrown so the caller can say "try again" without guessing.
 */
export async function runAdminTool(name: string, args: Args, ctx: AdminToolContext = {}): Promise<unknown> {
  try {
    return await run(name, args, ctx);
  } catch (err) {
    if (err instanceof NotFoundError) return { status: "not_found", message: err.message };
    if (err instanceof DomainError) return { status: "error", message: err.message };
    throw err;
  }
}

async function run(name: string, args: Args, ctx: AdminToolContext): Promise<unknown> {
  const { operationId, previewOnly } = ctx;
  switch (name) {
    case "getStoreSummary": {
      const [invoices, products, customers, purchases] = await Promise.all([getAllInvoices(), getAllProducts(), getAllCustomers(), getAllPurchases()]);
      // Same rules as the dashboard (src/app/page.tsx) and getCustomerDebt.
      const revenue = r2(invoices.filter((i) => i.paymentStatus !== "void" && i.paymentStatus !== "draft").reduce((s, i) => s + i.total, 0));
      const customersOwe = r2([...owedByCustomer(invoices).values()].reduce((s, n) => s + n, 0));
      const outstanding = r2(invoices.filter((i) => i.paymentStatus === "unpaid" || i.paymentStatus === "partial").reduce((s, i) => s + i.balance, 0));
      return {
        invoiceCount: invoices.length,
        revenue,
        outstanding,
        customersOwe,
        openDeliveries: invoices.filter(isOpenDelivery).length,
        incompleteDrafts: invoices.filter(isInvoiceIncomplete).map((i) => ({ id: i.id, invoiceNumber: i.invoiceNumber, customerName: i.customerName })),
        productCount: products.length,
        activeProductCount: products.filter((p) => p.active !== false).length,
        customerCount: customers.length,
        owedToVendors: r2(purchases.reduce((s, p) => s + purchaseOwed(p), 0)),
        today: storeDateKey(),
      };
    }

    case "listInvoices": {
      const from = dateArg(args.dateFrom, "dateFrom");
      const to = dateArg(args.dateTo, "dateTo");
      const status = args.status ? String(args.status) : undefined;
      const all = await getAllInvoices();
      const matches = all
        .filter(
          (i) =>
            inRange(storeDateKey(i.date), from, to) &&
            (!args.customerId || i.customerId === args.customerId) &&
            (!status || (status === "open" ? i.paymentStatus === "unpaid" || i.paymentStatus === "partial" : i.paymentStatus === status)) &&
            (!args.deliveryOnly || isOpenDelivery(i))
        )
        .sort((a, b) => b.date - a.date || b.createdAt - a.createdAt);
      const counted = matches.filter((i) => i.paymentStatus !== "void");
      const limit = args.limit ? Math.max(1, Number(args.limit)) : 50;
      return {
        count: matches.length,
        totalAmount: r2(counted.reduce((s, i) => s + i.total, 0)),
        totalBalance: r2(counted.reduce((s, i) => s + i.balance, 0)),
        invoices: matches.slice(0, limit).map(invoiceSummary),
        ...(matches.length > limit ? { note: `Showing ${limit} of ${matches.length}; the totals cover all of them.` } : {}),
      };
    }

    case "getInvoiceHistory": {
      const invoice = await invoiceFromArgs(args);
      const [logs, payments] = await Promise.all([getInvoiceLogs(invoice.id), getPaymentsForInvoice(invoice.id)]);
      return {
        invoice: invoiceSummary(invoice),
        log: logs.map((l) => ({ when: new Date(l.timestamp).toISOString(), who: l.actor, action: l.action, message: l.message })),
        payments: payments.map((p) => ({ id: p.id, amount: p.amount, method: p.method, note: p.note, when: new Date(p.createdAt).toISOString() })),
      };
    }

    case "getPaymentRequest": {
      const customer = await getCustomerById(String(args.customerId));
      if (!customer) throw new NotFoundError("Customer not found.");
      const invoices = (await getInvoicesForCustomer(customer.id)).filter(isStatementInvoice);
      const ids = Array.isArray(args.invoiceIds) ? new Set((args.invoiceIds as unknown[]).map(String)) : null;
      const picked = invoices
        .filter((i) => (ids ? ids.has(i.id) : args.include === "all" || statementOwed(i) > 0))
        .sort((a, b) => a.date - b.date || a.createdAt - b.createdAt);
      return {
        customer: { id: customer.id, name: customer.name, phone: customer.phone, address: customer.address },
        invoices: picked.map((i) => ({ ...invoiceSummary(i), owed: statementOwed(i), daysOld: daysSince(i.date) })),
        totals: statementTotals(picked),
        printLink: `/customers/${customer.id}/payment-request`,
        note: "Open the link in the app to tick these invoices and print or share the statement.",
      };
    }

    case "getCustomInvoice": {
      const invoice = await invoiceFromArgs(args);
      const { info, saved } = await currentPrintInfo(invoice);
      return { invoice: invoiceSummary(invoice), saved, info, printLink: `/custom-invoices/${invoice.id}` };
    }

    case "listVendors": {
      const [vendors, purchases] = await Promise.all([getAllVendors(), getAllPurchases()]);
      const owed = new Map<string, number>();
      for (const p of purchases) owed.set(p.vendorId, r2((owed.get(p.vendorId) ?? 0) + purchaseOwed(p)));
      return {
        vendors: vendors.filter((v) => args.includeInactive || v.active !== false).map((v) => ({ ...v, owed: owed.get(v.id) ?? 0 })),
        totalOwed: r2([...owed.values()].reduce((s, n) => s + n, 0)),
      };
    }

    case "searchVendor": {
      const vendors = await getAllVendors();
      const matches = findSimilarWithAliases(String(args.query ?? ""), vendors, (v) => v.name, () => [], 0.3);
      return { results: matches.slice(0, 8).map((m) => ({ id: m.item.id, name: m.item.name, phone: m.item.phone, active: m.item.active, score: Math.round(m.score * 100) / 100 })) };
    }

    case "getVendor": {
      const [vendor, purchases] = await Promise.all([getVendor(String(args.vendorId)), getPurchasesForVendor(String(args.vendorId))]);
      if (!vendor) throw new NotFoundError("Vendor not found.");
      return { vendor, owed: r2(purchases.reduce((s, p) => s + purchaseOwed(p), 0)), purchases: purchases.map(purchaseSummary), link: `/vendors/${vendor.id}` };
    }

    case "searchPurchases": {
      const from = dateArg(args.dateFrom, "dateFrom");
      const to = dateArg(args.dateTo, "dateTo");
      const status = args.status ? String(args.status) : undefined;
      const query = String(args.query ?? "");
      const matches = (await getAllPurchases()).filter(
        (p) =>
          (!args.vendorId || p.vendorId === args.vendorId) &&
          (!status || (status === "open" ? purchaseOwed(p) > 0 : p.paymentStatus === status)) &&
          inRange(p.dateKey, from, to) &&
          textMatches(query, [p.vendorInvoiceNumber, p.purchaseNumber, p.vendorName, p.notes, ...p.items.map((i) => i.productName)])
      );
      const counted = matches.filter((p) => p.paymentStatus !== "void");
      const limit = args.limit ? Math.max(1, Number(args.limit)) : 30;
      return {
        count: matches.length,
        total: r2(counted.reduce((s, p) => s + p.total, 0)),
        owed: r2(matches.reduce((s, p) => s + purchaseOwed(p), 0)),
        purchases: matches.slice(0, limit).map(purchaseSummary),
      };
    }

    case "getPurchase": {
      const purchase = await purchaseFromArgs(args);
      const payments = await getPaymentsForPurchase(purchase.id);
      return { purchase, payments, link: purchaseLink(purchase) };
    }

    case "createPurchase":
      return previewOnly ? purchaseCreatePreview(args) : savePurchase(args, operationId);

    case "recordVendorPayment": {
      const purchase = await purchaseFromArgs(args);
      const amount = Number(args.amount);
      assertPositiveAmount(amount, "Amount");
      if (purchase.paymentStatus === "void") throw new DomainError(`${purchase.purchaseNumber} was cancelled.`);
      if (amount > purchase.balance + 0.001) throw new DomainError(`That is more than what is still owed on ${purchase.purchaseNumber} ($${purchase.balance.toFixed(2)}).`);
      const method = optText(args.method, "Payment method", 100);
      const note = optText(args.note, "Note");
      if (previewOnly) {
        const amountPaid = r2(purchase.amountPaid + amount);
        return {
          status: "preview",
          preview: {
            action: "Record a payment to a vendor",
            purchase: { id: purchase.id, purchaseNumber: purchase.purchaseNumber, vendorName: purchase.vendorName, vendorInvoiceNumber: purchase.vendorInvoiceNumber, total: purchase.total },
            amount,
            method: method ?? "",
            before: { amountPaid: purchase.amountPaid, balance: purchase.balance, status: purchase.paymentStatus },
            after: { amountPaid, balance: r2(purchase.total - amountPaid), status: amountPaid >= purchase.total ? "paid" : "partial" },
          },
          pinnedArgs: { purchaseId: purchase.id, amount, ...(method ? { method } : {}), ...(note ? { note } : {}) },
        };
      }
      const saved = await recordVendorPayment({ purchaseId: purchase.id, amount, method, note, operationId });
      return { status: "recorded", purchase: purchaseSummary(saved), link: purchaseLink(saved) };
    }

    case "updatePurchaseInfo": {
      const purchase = await purchaseFromArgs(args);
      const changes: { vendorInvoiceNumber?: string; dateKey?: string; notes?: string } = {};
      const vin = optText(args.vendorInvoiceNumber, "Vendor invoice #", 100);
      if (vin !== undefined && vin !== purchase.vendorInvoiceNumber) changes.vendorInvoiceNumber = vin;
      const date = dateArg(args.date, "date");
      if (date !== undefined && date !== purchase.dateKey) changes.dateKey = date;
      const notes = optText(args.notes, "Notes");
      if (notes !== undefined && notes !== purchase.notes) changes.notes = notes;
      if (Object.keys(changes).length === 0) return { status: "unchanged", message: "Nothing to change: the purchase already has these details." };
      if (previewOnly) {
        if (changes.vendorInvoiceNumber) {
          const clash = await findVendorInvoiceClash(purchase.vendorId, changes.vendorInvoiceNumber, purchase.id);
          if (clash) throw new DomainError(`Vendor invoice #${changes.vendorInvoiceNumber} from this vendor is already saved as ${clash.purchaseNumber}.`);
        }
        const from: Record<string, unknown> = { vendorInvoiceNumber: purchase.vendorInvoiceNumber, dateKey: purchase.dateKey, notes: purchase.notes };
        return {
          status: "preview",
          preview: {
            action: "Fix a purchase's details (no change to items, money or stock)",
            purchase: { id: purchase.id, purchaseNumber: purchase.purchaseNumber, vendorName: purchase.vendorName },
            changes: Object.entries(changes).map(([field, to]) => ({ field: field === "dateKey" ? "date" : field, from: from[field], to })),
          },
          pinnedArgs: { purchaseId: purchase.id, ...changes, ...(changes.dateKey ? { date: changes.dateKey, dateKey: undefined } : {}) },
        };
      }
      const saved = await updatePurchaseInfo(purchase.id, changes, operationId);
      return { status: "updated", purchase: purchaseSummary(saved), link: purchaseLink(saved) };
    }

    case "cancelPurchase": {
      const purchase = await purchaseFromArgs(args);
      if (purchase.paymentStatus === "void") throw new DomainError(`${purchase.purchaseNumber} is already cancelled.`);
      if (previewOnly) {
        const products = new Map((await getAllProducts()).map((p) => [p.id, p]));
        const payments = (await getPaymentsForPurchase(purchase.id)).filter((p) => !p.voided);
        const stock = purchase.addedQuantities.map((a) => {
          const p = products.get(a.productId);
          const now = p?.quantity ?? null;
          return { productName: p?.name ?? a.productId, takeOut: a.quantity, stockNow: now, stockAfter: now === null ? null : now - a.quantity };
        });
        const below = stock.filter((s) => s.stockAfter !== null && s.stockAfter < 0).map((s) => `${s.productName}: stock would be ${s.stockAfter}`);
        return {
          status: "preview",
          preview: {
            action: "Cancel a purchase (kept as Cancelled, nothing deleted)",
            purchase: purchaseSummary(purchase),
            stockTakenBack: stock,
            paymentsMarkedVoided: payments.map((p) => ({ amount: p.amount, method: p.method })),
            owedToVendorDropsBy: purchaseOwed(purchase),
            note: "Product costs are not changed back.",
            ...(below.length ? { warnings: below } : {}),
          },
          pinnedArgs: { purchaseId: purchase.id },
        };
      }
      const { purchase: saved, stockWarnings } = await voidPurchase(purchase.id, operationId);
      return { status: "cancelled", purchase: purchaseSummary(saved), ...(stockWarnings.length ? { stockWarnings } : {}), link: purchaseLink(saved) };
    }

    case "createVendor": {
      const name = optText(args.name, "Vendor name", 200);
      if (!name) throw new DomainError("A vendor needs a name.");
      const fields = {
        name,
        contactName: optText(args.contactName, "Contact name", 200),
        phone: optText(args.phone, "Phone", 50),
        email: optText(args.email, "Email", 200),
        address: optText(args.address, "Address"),
        notes: optText(args.notes, "Notes"),
      };
      const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v)) as typeof fields;
      if (previewOnly) {
        const similar = findSimilarWithAliases(name, await getAllVendors(), (v) => v.name, () => [], 0.7).map((m) => ({ id: m.item.id, name: m.item.name }));
        return {
          status: "preview",
          preview: { action: "Add a new vendor", vendor: clean, ...(similar.length ? { warning: "Similar vendors already exist. Saving makes a new, separate vendor.", similarVendors: similar } : {}) },
          pinnedArgs: clean,
        };
      }
      const vendor = await createVendor({ ...clean, operationId });
      return { status: "created", vendor };
    }

    case "updateVendor": {
      const vendor = await getVendor(String(args.vendorId));
      if (!vendor) throw new NotFoundError("Vendor not found.");
      const changes: Record<string, string> = {};
      const list: { field: string; from: unknown; to: unknown }[] = [];
      for (const [field, max] of [["name", 200], ["contactName", 200], ["phone", 50], ["email", 200], ["address", 2000], ["notes", 2000]] as const) {
        const to = optText(args[field], field, max);
        if (to === undefined) continue;
        if (field === "name" && !to) throw new DomainError("The name cannot be empty.");
        const from = (vendor as unknown as Record<string, unknown>)[field] ?? "";
        if (from === to) continue;
        changes[field] = to;
        list.push({ field, from, to });
      }
      if (list.length === 0) return { status: "unchanged", message: "Nothing to change: the vendor already has these values." };
      if (previewOnly) {
        return { status: "preview", preview: { action: "Change a vendor", vendor: { id: vendor.id, name: vendor.name }, changes: list }, pinnedArgs: { vendorId: vendor.id, ...changes } };
      }
      await updateVendor(vendor.id, changes, operationId);
      return { status: "updated" };
    }

    case "recordCustomerPayment":
    case "adjustCustomerDebt": {
      const adjusting = name === "adjustCustomerDebt";
      const customer = await customerFromArgs(args);
      const amount = r2(Number(args.amount));
      assertPositiveAmount(amount, "Amount");
      const reason = adjusting ? optText(args.reason, "Reason", 500) : undefined;
      if (adjusting && !reason) throw new DomainError("A reason is required to adjust a customer's debt.");
      const method = adjusting ? undefined : optText(args.method, "Payment method", 100);
      const note = adjusting ? undefined : optText(args.note, "Note");
      const date = adjusting ? undefined : dateArg(args.date, "date");
      if (date && date > storeDateKey()) throw new DomainError("The payment date can't be in the future.");
      const open = (await getInvoicesForCustomer(customer.id)).filter(canReceivePayment).sort(compareOldestFirst);
      const owed = r2(open.reduce((sum, i) => sum + i.balance, 0));
      if (amount > owed + 0.001) throw new DomainError(`That is more than ${customer.name} owes ($${owed.toFixed(2)}).`);
      if (previewOnly) {
        const { allocations } = allocatePaymentOldestFirst(open, amount);
        const applied = new Map(allocations.map((a) => [a.invoiceId, a.amount]));
        return {
          status: "preview",
          preview: {
            action: adjusting ? "Lower a customer's debt (adjustment, not money received), oldest invoice first" : "Record a customer payment, oldest invoice first",
            customer: { id: customer.id, name: customer.name },
            amount,
            ...(adjusting ? { reason } : { method: method ?? "", date: date ?? storeDateKey() }),
            debtBefore: owed,
            debtAfter: r2(owed - amount),
            invoices: open.map((i) => {
              const a = applied.get(i.id) ?? 0;
              const paidAfter = r2(i.amountPaid + a);
              return { invoiceNumber: i.invoiceNumber, date: storeDateKey(i.date), total: i.total, paidBefore: i.amountPaid, stillOwed: i.balance, applied: a, statusAfter: computePaymentStatus(i.total, paidAfter, i.paymentStatus) };
            }),
          },
          pinnedArgs: { customerId: customer.id, amount, ...(reason ? { reason } : {}), ...(method ? { method } : {}), ...(note ? { note } : {}), ...(date ? { date } : {}) },
        };
      }
      // Noon on the chosen day keeps the date right whatever time zone the server runs in.
      const paidAt = date && date !== storeDateKey() ? Date.parse(`${date}T12:00:00`) : undefined;
      const saved = await recordCustomerPayment({
        customerId: customer.id,
        amount,
        actor: "ai",
        operationId,
        ...(adjusting ? { kind: "adjustment" as const, reason } : { method, note, ...(paidAt ? { paidAt } : {}) }),
      });
      return {
        status: "recorded",
        customer: { id: customer.id, name: customer.name },
        amount: saved.amount,
        applied: saved.allocations.map((a) => ({ invoiceNumber: a.invoiceNumber, amount: a.amount, stillOwed: a.balanceAfter })),
        link: `/customers/${customer.id}`,
      };
    }

    case "changePayment": {
      const payment = await getPaymentById(String(args.paymentId ?? ""));
      if (!payment) throw new NotFoundError("Payment not found. Use searchPayments to find its id.");
      const action = args.action === "edit" || args.action === "cancel" ? args.action : null;
      if (!action) throw new DomainError("action must be 'edit' or 'cancel'.");
      const reason = optText(args.reason, "Reason", 500);
      if (!reason) throw new DomainError("A reason is required to change a payment.");
      if (payment.cancelled) throw new DomainError("This payment was already cancelled.");
      const newAmount = action === "cancel" ? 0 : r2(Number(args.amount));
      if (action === "edit") assertPositiveAmount(newAmount, "Amount");
      if (action === "edit" && newAmount === payment.amount) throw new DomainError("The new amount is the same as the old one.");
      const delta = r2(newAmount - payment.amount);
      if (previewOnly) {
        let effect: Record<string, unknown>;
        if (payment.invoiceId) {
          const inv = await getInvoice(payment.invoiceId);
          if (!inv) throw new NotFoundError("The invoice this payment belongs to was not found.");
          const paid = r2(inv.amountPaid + delta);
          if (delta > 0 && paid > inv.total) throw new DomainError(`That would pay invoice #${inv.invoiceNumber} more than its total ($${inv.total.toFixed(2)}).`);
          effect = {
            invoice: { invoiceNumber: inv.invoiceNumber, total: inv.total },
            before: { amountPaid: inv.amountPaid, balance: inv.balance, status: inv.paymentStatus },
            after: { amountPaid: paid, balance: r2(inv.total - paid), status: computePaymentStatus(inv.total, paid, inv.paymentStatus) },
          };
        } else {
          const customer = payment.customerId ? await getCustomerById(payment.customerId) : null;
          const before = customer?.credit ?? 0;
          if (r2(before + delta) < 0) throw new DomainError(`The customer only has $${before.toFixed(2)} credit left.`);
          effect = { customerCredit: { before, after: r2(before + delta) } };
        }
        return {
          status: "preview",
          preview: {
            action: action === "cancel" ? "Cancel a payment (kept, marked cancelled)" : "Change a payment's amount",
            payment: { id: payment.id, kind: payment.kind ?? "payment", amount: payment.amount, date: storeDateKey(payment.paidAt ?? payment.createdAt), method: payment.method ?? "" },
            newAmount,
            reason,
            ...effect,
          },
          pinnedArgs: { paymentId: payment.id, action, reason, ...(action === "edit" ? { amount: newAmount } : {}) },
        };
      }
      const saved = await changePayment({ paymentId: payment.id, action, amount: action === "edit" ? newAmount : undefined, reason, actor: "ai", operationId });
      return {
        status: action === "cancel" ? "cancelled" : "updated",
        payment: { id: saved.payment.id, amount: saved.payment.amount, cancelled: saved.payment.cancelled ?? false },
        ...(saved.invoice ? { invoice: invoiceSummary(saved.invoice), link: `/invoices/${saved.invoice.id}` } : {}),
        ...(saved.credit !== undefined ? { customerCredit: saved.credit } : {}),
      };
    }

    case "saveCustomInvoice": {
      const invoice = await invoiceFromArgs(args);
      const { info: current } = await currentPrintInfo(invoice);
      const merged: Record<string, unknown> = { ...current };
      for (const key of ["template", "date", "dueDate", "deliveryDate", "po", "notes", "terms"] as const) if (args[key] !== undefined) merged[key] = args[key];
      for (const key of ["from", "billTo", "shipTo"] as const) {
        if (args[key] && typeof args[key] === "object") merged[key] = { ...(current[key] as object), ...(args[key] as object) };
      }
      // The app's own validation for this form: only print fields, never items or money.
      const info = requirePrintInfo(merged);
      if (previewOnly) {
        const changes = (Object.keys(info) as (keyof typeof info)[])
          .filter((k) => JSON.stringify(info[k]) !== JSON.stringify(current[k]))
          .map((k) => ({ field: k, from: current[k], to: info[k] }));
        if (changes.length === 0 && (await getInvoicePrintInfo(invoice.id))) return { status: "unchanged", message: "Nothing to change." };
        return {
          status: "preview",
          preview: { action: "Save the Custom Invoice print information", invoice: invoiceSummary(invoice), changes, note: "Items, prices, totals and debt are not changed." },
          pinnedArgs: { invoiceId: invoice.id, ...info },
        };
      }
      const saved = await saveInvoicePrintInfo({ invoiceId: invoice.id, ...info });
      return { status: "saved", info: saved, printLink: `/custom-invoices/${invoice.id}` };
    }

    default:
      return { status: "error", message: `Unknown tool: ${name}` };
  }
}

/** The saved print info, or exactly what the Custom Invoice page pre-fills the first time. */
async function currentPrintInfo(invoice: Invoice): Promise<{ info: Omit<InvoicePrintInfo, "invoiceId" | "updatedAt">; saved: boolean }> {
  const [saved, defaults, customer] = await Promise.all([
    getInvoicePrintInfo(invoice.id),
    getCustomInvoiceDefaults(),
    invoice.customerId ? getCustomerById(invoice.customerId) : Promise.resolve(null),
  ]);
  if (saved) {
    const info: Partial<InvoicePrintInfo> = { ...saved };
    delete info.invoiceId;
    delete info.updatedAt;
    return { info: info as Omit<InvoicePrintInfo, "invoiceId" | "updatedAt">, saved: true };
  }
  return {
    saved: false,
    info: {
      template: "professional",
      from: defaults.from,
      billTo: { address: customer?.address ?? "", phone: customer?.phone ?? "" },
      shipTo: { name: customer?.contactName ?? "", address: customer?.shippingAddress ?? "", phone: "" },
      date: storeDateKey(invoice.date),
      dueDate: "",
      deliveryDate: "",
      po: "",
      notes: "",
      terms: defaults.terms,
    },
  };
}

/* ------------------------------ purchases ------------------------------ */

interface ResolvedPurchase {
  vendor: Vendor;
  vendorInvoiceNumber: string;
  dateKey: string;
  lines: { product: Product; quantity: number; cost: number; unit: string; costFromProduct: boolean }[];
  shipping: number;
  discount: number;
  notes: string;
  updateCost: boolean;
  paidNow: number;
  payMethod?: string;
  subtotal: number;
  total: number;
}

/**
 * Matches the vendor and products of a new purchase and checks it the way createPurchase will (amounts, paid ≤
 * total, vendor invoice # not used yet). Returns a question (`early`) when something has to be asked first.
 */
async function resolvePurchase(args: Args): Promise<{ early: unknown } | ResolvedPurchase> {
  const vendors = await getAllVendors();
  let vendor: Vendor | null = null;
  if (args.vendorId) {
    vendor = vendors.find((v) => v.id === String(args.vendorId)) ?? null;
    if (!vendor) return { early: { status: "not_found", message: "vendorId not found." } };
  } else if (args.vendorName) {
    const m = matchVendor(String(args.vendorName), vendors);
    if (m.status === "ambiguous") return { early: { status: "needs_confirmation", message: "Several vendors look similar. Ask which one, then pass its vendorId.", candidates: m.candidates } };
    if (m.status === "not_found") return { early: { status: "needs_new_vendor", message: `No vendor matches "${args.vendorName}". Offer to add it with createVendor.`, query: args.vendorName } };
    vendor = m.vendor;
  } else {
    return { early: { status: "needs_more_info", message: "Which vendor is this purchase from?" } };
  }

  const rawItems = Array.isArray(args.items) ? (args.items as Args[]) : [];
  if (rawItems.length === 0) return { early: { status: "needs_more_info", message: "Which products, how many and at what cost?" } };
  if (rawItems.length > 200) throw new DomainError("Too many lines on one purchase.");
  const catalog = await getAllProducts();
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const lines: ResolvedPurchase["lines"] = [];
  const missing: string[] = [];
  for (const raw of rawItems) {
    let product: Product | null = null;
    if (raw.productId) {
      product = byId.get(String(raw.productId)) ?? null;
      if (!product) return { early: { status: "not_found", message: `productId ${raw.productId} not found.` } };
    } else if (raw.productName) {
      const m = matchProduct(String(raw.productName), catalog);
      if (m.status === "ambiguous") return { early: { status: "needs_confirmation", message: `Several products look like "${raw.productName}". Ask which one, then pass its productId.`, candidates: m.candidates } };
      if (m.status === "not_found") return { early: { status: "needs_new_product", message: `No product matches "${raw.productName}". Offer to add it with createProduct first.`, query: raw.productName } };
      product = m.product;
    } else {
      return { early: { status: "needs_more_info", message: "Every line needs a product (productId or productName)." } };
    }
    const quantity = Number(raw.quantity);
    if (raw.quantity === undefined || !Number.isFinite(quantity) || quantity <= 0) {
      missing.push(`quantity of ${product.name}`);
      continue;
    }
    const costFromProduct = raw.cost === undefined || raw.cost === null;
    const cost = costFromProduct ? product.cost : Number(raw.cost);
    if (cost === undefined || cost === null) {
      missing.push(`cost of ${product.name}`);
      continue;
    }
    assertPositiveAmount(quantity, `Quantity of ${product.name}`);
    assertNonNegativeAmount(cost, `Cost of ${product.name}`);
    lines.push({ product, quantity, cost, unit: raw.unit ? String(raw.unit).trim() : product.defaultUnit, costFromProduct });
  }
  if (missing.length) return { early: { status: "needs_more_info", message: `Ask the user for: ${missing.join(", ")}.`, missing } };

  const shipping = args.shipping !== undefined ? Number(args.shipping) : 0;
  const discount = args.discount !== undefined ? Number(args.discount) : 0;
  assertNonNegativeAmount(shipping, "Shipping / fees");
  assertNonNegativeAmount(discount, "Discount");
  // Same math as createPurchase (which recomputes it on save anyway).
  const subtotal = r2(lines.reduce((s, l) => s + r2(l.quantity * l.cost), 0));
  const total = r2(subtotal + shipping - discount);
  if (total < 0) throw new DomainError("The discount can't be more than the purchase total.");
  const paidNow = args.payInFull === true ? total : args.paidNow !== undefined ? Number(args.paidNow) : 0;
  assertNonNegativeAmount(paidNow, "Amount paid");
  if (paidNow > total + 0.001) throw new DomainError(`Amount paid ($${paidNow.toFixed(2)}) is more than the purchase total ($${total.toFixed(2)}).`);

  const vendorInvoiceNumber = optText(args.vendorInvoiceNumber, "Vendor invoice #", 100) ?? "";
  const clash = await findVendorInvoiceClash(vendor.id, vendorInvoiceNumber);
  if (clash) throw new DomainError(`Vendor invoice #${vendorInvoiceNumber} from this vendor is already saved as ${clash.purchaseNumber}.`);

  return {
    vendor,
    vendorInvoiceNumber,
    dateKey: dateArg(args.date ?? args.dateKey, "date") ?? storeDateKey(),
    lines,
    shipping,
    discount,
    notes: optText(args.notes, "Notes") ?? "",
    updateCost: args.updateCost !== false,
    paidNow: r2(paidNow),
    payMethod: optText(args.payMethod, "Payment method", 100) || undefined,
    subtotal,
    total,
  };
}

async function purchaseCreatePreview(args: Args) {
  const r = await resolvePurchase(args);
  if ("early" in r) return r.early;
  const warnings: string[] = [];
  if (!r.vendorInvoiceNumber) warnings.push("No vendor invoice # given; it helps find this purchase later.");
  const fromProduct = r.lines.filter((l) => l.costFromProduct).map((l) => l.product.name);
  if (fromProduct.length) warnings.push(`Cost taken from the product's saved cost for: ${fromProduct.join(", ")}.`);
  // Stock after: lines for the same product add up, like the save does.
  const added = new Map<string, number>();
  for (const l of r.lines) added.set(l.product.id, (added.get(l.product.id) ?? 0) + l.quantity);
  return {
    status: "preview",
    preview: {
      action: "Save a purchase from a vendor (adds stock)",
      vendor: { id: r.vendor.id, name: r.vendor.name },
      vendorInvoiceNumber: r.vendorInvoiceNumber,
      date: r.dateKey,
      items: r.lines.map((l) => ({ productId: l.product.id, productName: l.product.name, quantity: l.quantity, unit: l.unit, cost: l.cost, lineTotal: r2(l.quantity * l.cost) })),
      shipping: r.shipping,
      discount: r.discount,
      subtotal: r.subtotal,
      total: r.total,
      paidNow: r.paidNow,
      stillOwedAfter: r2(r.total - r.paidNow),
      stock: [...added].map(([id, qty]) => {
        const p = r.lines.find((l) => l.product.id === id)!.product;
        const now = p.quantity ?? null;
        return now === null ? { productName: p.name, stockNow: "not counted yet", stockAfter: qty } : { productName: p.name, stockNow: now, stockAfter: now + qty };
      }),
      costChanges: r.updateCost
        ? r.lines.filter((l) => (l.product.cost ?? null) !== l.cost).map((l) => ({ productName: l.product.name, from: l.product.cost ?? null, to: l.cost }))
        : "Product costs are kept (updateCost=false).",
      ...(warnings.length ? { warnings } : {}),
    },
    pinnedArgs: {
      vendorId: r.vendor.id,
      vendorInvoiceNumber: r.vendorInvoiceNumber,
      date: r.dateKey,
      items: r.lines.map((l) => ({ productId: l.product.id, quantity: l.quantity, cost: l.cost, unit: l.unit })),
      shipping: r.shipping,
      discount: r.discount,
      notes: r.notes,
      updateCost: r.updateCost,
      paidNow: r.paidNow,
      ...(r.payMethod ? { payMethod: r.payMethod } : {}),
    },
  };
}

async function savePurchase(args: Args, operationId?: string) {
  const r = await resolvePurchase(args);
  if ("early" in r) return r.early;
  const { purchase, stockNotes } = await createPurchase({
    vendorId: r.vendor.id,
    vendorInvoiceNumber: r.vendorInvoiceNumber,
    dateKey: r.dateKey,
    items: r.lines.map((l) => ({ productId: l.product.id, quantity: l.quantity, cost: l.cost, unit: l.unit })),
    shipping: r.shipping,
    discount: r.discount,
    notes: r.notes,
    updateCost: r.updateCost,
    paidNow: r.paidNow,
    payMethod: r.paidNow > 0 ? r.payMethod : undefined,
    operationId,
  });
  return { status: "created", purchase: purchaseSummary(purchase), ...(stockNotes.length ? { stockNotes } : {}), link: purchaseLink(purchase) };
}
