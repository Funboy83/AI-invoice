import { findSimilarWithAliases, normalizeVN, sameWithAccents, similarity, wordMatchScore, type Match } from "@/lib/similarity";
import {
  getAllProducts,
  getProductById,
  getProductsByIds,
  createProduct as createProductDoc,
  updateProduct as updateProductDoc,
  addProductAlias as addProductAliasDoc,
  getAllCustomers,
  getCustomerById,
  createCustomer as createCustomerDoc,
  updateCustomer as updateCustomerDoc,
  addCustomerAlias as addCustomerAliasDoc,
  createInvoice,
  updateInvoiceWithLog,
  copyInvoice as copyInvoiceDoc,
  recordPayment as recordPaymentDoc,
  getAllPayments,
  getInvoice as getInvoiceDoc,
  getInvoiceByNumber,
  getAllInvoices,
  getInvoicesForCustomer,
  getCustomerDebt as getCustomerDebtDoc,
  getUnpaidInvoices as getUnpaidInvoicesDoc,
  DomainError,
  NotFoundError,
} from "@/lib/server/businessStore";
import { assertNonNegativeAmount, calcTotals } from "@/lib/invoiceMath";
import { isOpenDelivery, type Customer, type Invoice, type InvoiceLineItem, type InvoiceStatus, type Product } from "@/lib/types";

/** Anthropic tool-use definitions exposed to the assistant. */
export const toolDefinitions = [
  {
    name: "searchProduct",
    description:
      "Search the product catalog by name/alias/nickname (Vietnamese, accent-insensitive, typo-tolerant). Always use this before creating a product or adding an invoice line item.",
    input_schema: {
      type: "object" as const,
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "getProduct",
    description: "Fetch a single product by id.",
    input_schema: {
      type: "object" as const,
      properties: { productId: { type: "string" } },
      required: ["productId"],
    },
  },
  {
    name: "createProduct",
    description:
      "Create a new product. Only call this after searchProduct shows no good match, or after the user explicitly confirms they want a new, separate product despite similar existing ones. Set force=true only after that explicit confirmation.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
        defaultUnit: { type: "string", description: "e.g. thùng, kg, bao, chai. Defaults to 'unit'." },
        defaultPrice: { type: "number" },
        cost: { type: "number" },
        quantity: { type: "number", description: "Starting stock count. Omit entirely to leave this product's stock untracked — invoicing will never touch it." },
        category: { type: "string" },
        barcode: { type: "string" },
        notes: { type: "string" },
        force: { type: "boolean" },
      },
      required: ["name", "defaultPrice"],
    },
  },
  {
    name: "updateProduct",
    description:
      "Update fields of an existing product (name, price, unit, category, cost, quantity, notes, active). Setting quantity also starts/corrects stock tracking for a product that didn't have it before — only do this if the user explicitly gives you a stock count.",
    input_schema: {
      type: "object" as const,
      properties: {
        productId: { type: "string" },
        name: { type: "string" },
        defaultUnit: { type: "string" },
        defaultPrice: { type: "number" },
        cost: { type: "number" },
        quantity: { type: "number" },
        category: { type: "string" },
        notes: { type: "string" },
        active: { type: "boolean" },
      },
      required: ["productId"],
    },
  },
  {
    name: "addProductAlias",
    description:
      "Remember a nickname/alias for a product so it matches automatically next time. Only call after the user confirms the alias is correct.",
    input_schema: {
      type: "object" as const,
      properties: { productId: { type: "string" }, alias: { type: "string" } },
      required: ["productId", "alias"],
    },
  },
  {
    name: "searchCustomer",
    description: "Search customers by name/alias/nickname (Vietnamese, accent-insensitive, typo-tolerant).",
    input_schema: {
      type: "object" as const,
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "getCustomer",
    description: "Fetch a single customer by id.",
    input_schema: {
      type: "object" as const,
      properties: { customerId: { type: "string" } },
      required: ["customerId"],
    },
  },
  {
    name: "createCustomer",
    description:
      "Create a new customer. Only call after searchCustomer shows no good match, or after explicit user confirmation despite similar existing customers (force=true).",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
        contactName: { type: "string" },
        phone: { type: "string" },
        email: { type: "string" },
        address: { type: "string" },
        shippingAddress: { type: "string" },
        notes: { type: "string" },
        defaultShipping: { type: "number" },
        force: { type: "boolean" },
      },
      required: ["name"],
    },
  },
  {
    name: "updateCustomer",
    description: "Update fields of an existing customer.",
    input_schema: {
      type: "object" as const,
      properties: {
        customerId: { type: "string" },
        name: { type: "string" },
        contactName: { type: "string" },
        phone: { type: "string" },
        email: { type: "string" },
        address: { type: "string" },
        shippingAddress: { type: "string" },
        notes: { type: "string" },
        defaultShipping: { type: "number" },
        active: { type: "boolean" },
      },
      required: ["customerId"],
    },
  },
  {
    name: "addCustomerAlias",
    description: "Remember a nickname/alias for a customer. Only call after the user confirms it.",
    input_schema: {
      type: "object" as const,
      properties: { customerId: { type: "string" }, alias: { type: "string" } },
      required: ["customerId", "alias"],
    },
  },
  {
    name: "getLastPrice",
    description: "Get the most recent price this customer was charged for a product, from past invoices.",
    input_schema: {
      type: "object" as const,
      properties: { customerId: { type: "string" }, productId: { type: "string" } },
      required: ["customerId", "productId"],
    },
  },
  {
    name: "createInvoiceDraft",
    description:
      "Create a new DRAFT invoice for a customer with one or more line items, parsed from a (possibly messy Vietnamese) order message. All amounts are USD. Each item is matched against the product catalog by name/alias. If a customer or product doesn't clearly match, this returns needs_confirmation/needs_new_customer/needs_new_product and you must resolve it (ask the user, or create the entity) before retrying. Quantity and price are preferred but NOT required — if either can't be determined (no quantity in the text, and no last/default price available), the line is saved as-is and marked incomplete; the invoice is still created (as an incomplete temp draft) rather than rejected, and the result lists incompleteItems for you to relay to the user. Price otherwise falls back to last price charged to this customer, then the product default price, with a warning if ambiguous — application code always computes totals, never trust your own math.",
    input_schema: {
      type: "object" as const,
      properties: {
        customerId: { type: "string" },
        customerName: { type: "string" },
        originalOrderText: { type: "string", description: "The raw pasted customer message, preserved for reference." },
        shipping: { type: "number" },
        discount: { type: "number" },
        notes: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              productId: { type: "string" },
              productName: { type: "string" },
              quantity: { type: "number", description: "Omit if unknown from the order text — the item will be marked incomplete." },
              unit: { type: "string" },
              price: { type: "number", description: "USD. Omit to fall back to last/default price." },
            },
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "getInvoice",
    description: "Fetch a single invoice by id or invoice number.",
    input_schema: {
      type: "object" as const,
      properties: { invoiceId: { type: "string" }, invoiceNumber: { type: "string" } },
    },
  },
  {
    name: "searchInvoices",
    description: "Search/filter invoices by customer, status, or text (invoice number / customer name).",
    input_schema: {
      type: "object" as const,
      properties: {
        text: { type: "string" },
        customerId: { type: "string" },
        status: { type: "string", enum: ["draft", "unpaid", "partial", "paid", "void"] },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "getCustomerInvoices",
    description: "List all invoices for a specific customer, most recent first.",
    input_schema: {
      type: "object" as const,
      properties: { customerId: { type: "string" } },
      required: ["customerId"],
    },
  },
  {
    name: "getCustomerDebt",
    description: "Get a customer's total outstanding balance and the list of unpaid/partial invoices behind it.",
    input_schema: {
      type: "object" as const,
      properties: { customerId: { type: "string" } },
      required: ["customerId"],
    },
  },
  {
    name: "getUnpaidInvoices",
    description: "List invoices that are unpaid or partial (or a specific status if given).",
    input_schema: {
      type: "object" as const,
      properties: { status: { type: "string", enum: ["draft", "unpaid", "partial", "paid", "void"] } },
    },
  },
  {
    name: "addInvoiceItem",
    description: "Add a line item to an existing invoice (or increase quantity if the product is already on it).",
    input_schema: {
      type: "object" as const,
      properties: {
        invoiceId: { type: "string" },
        productId: { type: "string" },
        productName: { type: "string" },
        quantity: { type: "number" },
        unit: { type: "string" },
        price: { type: "number" },
        reason: { type: "string" },
      },
      required: ["invoiceId", "quantity", "reason"],
    },
  },
  {
    name: "updateInvoiceItem",
    description: "Change the quantity, price, or unit of an existing invoice line item (match by productId or productName).",
    input_schema: {
      type: "object" as const,
      properties: {
        invoiceId: { type: "string" },
        productId: { type: "string" },
        productName: { type: "string" },
        quantity: { type: "number" },
        price: { type: "number" },
        unit: { type: "string" },
        reason: { type: "string" },
      },
      required: ["invoiceId", "reason"],
    },
  },
  {
    name: "removeInvoiceItem",
    description: "Remove a line item from an existing invoice (match by productId or productName).",
    input_schema: {
      type: "object" as const,
      properties: {
        invoiceId: { type: "string" },
        productId: { type: "string" },
        productName: { type: "string" },
        reason: { type: "string" },
      },
      required: ["invoiceId", "reason"],
    },
  },
  {
    name: "updateInvoice",
    description:
      "Edit invoice-level fields: shipping, discount, notes, status, or customer. Requires a short reason, saved to the permanent audit log.",
    input_schema: {
      type: "object" as const,
      properties: {
        invoiceId: { type: "string" },
        shipping: { type: "number" },
        discount: { type: "number" },
        notes: { type: "string" },
        status: { type: "string", enum: ["draft", "unpaid", "partial", "paid", "void"] },
        customerId: { type: "string" },
        customerName: { type: "string" },
        reason: { type: "string" },
      },
      required: ["invoiceId", "reason"],
    },
  },
  {
    name: "finalizeInvoice",
    description: "Move an invoice from draft to an active (unpaid/partial/paid) state, ready to send/print.",
    input_schema: {
      type: "object" as const,
      properties: { invoiceId: { type: "string" } },
      required: ["invoiceId"],
    },
  },
  {
    name: "copyInvoice",
    description:
      "Duplicate a previous invoice into a brand-new draft (does not modify the original). After copying, use addInvoiceItem/updateInvoiceItem/removeInvoiceItem to apply any requested changes.",
    input_schema: {
      type: "object" as const,
      properties: { invoiceId: { type: "string" }, invoiceNumber: { type: "string" } },
    },
  },
  {
    name: "recordPayment",
    description: "Record a payment against an invoice, updating amountPaid/balance/paymentStatus.",
    input_schema: {
      type: "object" as const,
      properties: {
        invoiceId: { type: "string" },
        amount: { type: "number" },
        method: { type: "string" },
        note: { type: "string" },
      },
      required: ["invoiceId", "amount"],
    },
  },
  {
    name: "createDeliveryOrder",
    description:
      "Create a DELIVERY ORDER: goods are delivered now and priced later. It is saved straight away as an unpaid invoice tagged Delivery (stock is taken, it shows in the customer's account), and any item without a price is saved at $0 — that is allowed for deliveries and is NOT an incomplete line. Use this (not createInvoiceDraft) when the user says it's a delivery / giao hàng / đơn giao / ship trước tính tiền sau, or asks for a delivery order. Customer and product matching works exactly like createInvoiceDraft (needs_confirmation / needs_new_customer / needs_new_product). Every item needs a quantity. Only pass a price if the user actually stated one — never fill in last/default prices. If the result is needs_confirmation with a preview, show the summary and ask with requestUserInput (use the confirmChoices as options); call again with confirmed=true only after she answers yes.",
    input_schema: {
      type: "object" as const,
      properties: {
        customerId: { type: "string" },
        customerName: { type: "string" },
        originalOrderText: { type: "string", description: "The raw message the order came from." },
        shipping: { type: "number" },
        notes: { type: "string" },
        confirmed: { type: "boolean", description: "Set true only after the user confirmed the preview in reply to your question." },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              productId: { type: "string" },
              productName: { type: "string" },
              quantity: { type: "number" },
              unit: { type: "string" },
              price: { type: "number", description: "USD. Omit unless the user stated a price — it stays $0 until the delivery is converted." },
            },
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "getDeliveries",
    description:
      "List and count delivery orders, optionally for one customer. Default status 'open' = delivered but not yet priced/converted. Returns count, each delivery (number, date, items, which items still have no price) and the total quantity per product. Use for questions like 'chị Hoa có mấy đơn giao chưa tính tiền?'.",
    input_schema: {
      type: "object" as const,
      properties: {
        customerId: { type: "string" },
        customerName: { type: "string", description: "Matched like searchCustomer if customerId is not known." },
        status: { type: "string", enum: ["open", "converted", "all"] },
      },
    },
  },
  {
    name: "convertDelivery",
    description:
      "Turn an OPEN delivery order into the final priced invoice: sets the prices given and marks the delivery converted (same invoice number, still unpaid, the tag stays for history). Every line still at $0 must get a price in `prices` — an explicit 0 is accepted (e.g. a free sample). If a price is missing the result lists the items to ask about. Prices for products the customer bought before can be looked up with getLastPrice to suggest them, but ask before using them. Needs a short reason for the audit log.",
    input_schema: {
      type: "object" as const,
      properties: {
        invoiceId: { type: "string" },
        invoiceNumber: { type: "string" },
        prices: {
          type: "array",
          items: {
            type: "object",
            properties: { productId: { type: "string" }, productName: { type: "string" }, price: { type: "number" } },
            required: ["price"],
          },
        },
        shipping: { type: "number" },
        discount: { type: "number" },
        reason: { type: "string" },
      },
      required: ["prices", "reason"],
    },
  },
  {
    name: "requestUserInput",
    description:
      "Pause the task and ask the user something. Call this whenever you need missing information (quantity, price), a choice between similar customers/products, or approval before continuing — instead of guessing and instead of ending your reply with a question. The question is saved, the task waits, and the user's next message is the answer. Put the complete question in `question`.",
    input_schema: {
      type: "object" as const,
      properties: {
        question: { type: "string", description: "The full question for the user, in their language." },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "Tap-to-answer buttons shown under the question (up to 6). Each is a short, complete answer in the user's language that you will understand on its own as her reply, e.g. the similar customers/products by name with a detail that tells them apart (\"Chị Hoa Lee – 0909 123 456\"), plus \"Khách mới, không phải ai ở trên\" when creating a new one is possible. Give options whenever the answer is a choice (which customer/product, yes/no, which invoice); leave out only for free-form answers like a price or quantity.",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "searchPayments",
    description: "List recorded payments, optionally filtered by invoice or customer.",
    input_schema: {
      type: "object" as const,
      properties: { invoiceId: { type: "string" }, customerId: { type: "string" } },
    },
  },
];

type ToolArgs = Record<string, unknown>;

/** Tools that change data. Each call gets a stable operation id so a retry or worker restart never applies it twice. */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "createProduct",
  "updateProduct",
  "addProductAlias",
  "createCustomer",
  "updateCustomer",
  "addCustomerAlias",
  "createInvoiceDraft",
  "createDeliveryOrder",
  "convertDelivery",
  "addInvoiceItem",
  "updateInvoiceItem",
  "removeInvoiceItem",
  "updateInvoice",
  "finalizeInvoice",
  "copyInvoice",
  "recordPayment",
]);

export interface ToolContext {
  /** Stable per tool call (jobId + tool_use id); passed to every mutating store call. */
  operationId?: string;
  /** True only when this job is the user's reply to a question the AI asked — the only time force=true is honoured. */
  canConfirm?: boolean;
  /** Where the message came from. Telegram messages must have a delivery order confirmed before it is saved. */
  channel?: "app" | "telegram" | "api";
  /**
   * Outside AI apps (API / MCP, see src/lib/server/externalApi.ts): createInvoiceDraft, createDeliveryOrder and the
   * product tools (createProduct, updateProduct, addProductAlias) check everything and return what WOULD be saved
   * (status "preview", with `pinnedArgs`) without writing anything.
   */
  previewOnly?: boolean;
  /** Optional timing hook (phase name, ms, counts). Must never receive order text, names or other customer data. */
  trace?: (phase: string, ms: number, fields?: Record<string, number>) => void;
}

/** Ledger-friendly id for one tool call: the same (job, tool_use id) always maps to the same operation. */
export function operationIdFor(jobId: string, toolUseId: string): string {
  return `${jobId}__${toolUseId}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

/** Confident match cutoff for auto-using a product/customer without asking. */
const AUTO_MATCH_THRESHOLD = 0.82;
const AMBIGUOUS_THRESHOLD = 0.55;

/** The best match must beat the runner-up by at least this much to be picked without asking. */
const CLEAR_LEAD = 0.08;

/**
 * Picks a match without asking only when it is clearly the one meant: the typed text equals exactly one candidate's
 * name/alias (with accents first, so "Chị Hòa" picks Chị Hòa, not Chị Hoa), or the best score is above the
 * auto-match cutoff and clearly ahead of the next one. Ties ("chi hoa" vs Chị Hoa and Chị Hòa, "gao" vs two kinds
 * of rice) return null so the user is asked.
 */
function pickConfident<T>(query: string, matches: Match<T>[], namesOf: (item: T) => string[]): T | null {
  const exact = matches.filter((m) => namesOf(m.item).some((n) => sameWithAccents(query, n)));
  if (exact.length === 1) return exact[0].item;
  if (exact.length > 1) return null;
  // Same idea without accents: "co lan" is exactly Cô Lan (Cô Lành only starts the same way), but "chi hoa" is
  // exactly both Chị Hoa and Chị Hòa, so that one is asked.
  const exactNoAccents = matches.filter((m) => namesOf(m.item).some((n) => normalizeVN(n) === normalizeVN(query)));
  if (exactNoAccents.length === 1) return exactNoAccents[0].item;
  if (exactNoAccents.length > 1) return null;
  const [best, second] = matches;
  if (!best || best.score < AUTO_MATCH_THRESHOLD) return null;
  if (second && best.score - second.score < CLEAR_LEAD) return null;
  return best.item;
}

type AliasSuggestion = { kind: "product" | "customer"; id: string; name: string; inputText: string };

/**
 * Aliases stay at 0 in practice unless something actually prompts the AI to save one for an auto-matched (fuzzy,
 * not exact) name — the system prompt alone only covers the "confirmed new item" flow. Called at every fuzzy-match
 * site with the input text the user actually typed; returns a suggestion only when that phrasing differs from the
 * canonical name and isn't already a known alias, so the AI isn't nagged into re-asking about the same alias twice.
 */
function buildAliasSuggestion(kind: "product" | "customer", id: string, canonicalName: string, aliases: string[], inputText: string): AliasSuggestion | null {
  const normInput = normalizeVN(inputText);
  if (!normInput || normInput === normalizeVN(canonicalName)) return null;
  if (aliases.some((a) => normalizeVN(a) === normInput)) return null;
  return { kind, id, name: canonicalName, inputText: inputText.trim() };
}

function summarizeProduct(p: Product) {
  return { id: p.id, name: p.name, aliases: p.aliases, defaultUnit: p.defaultUnit, defaultPrice: p.defaultPrice, category: p.category };
}
function summarizeCustomer(c: Customer) {
  return { id: c.id, name: c.name, aliases: c.aliases, phone: c.phone, address: c.address };
}

type ProductMatch =
  | { status: "match"; product: Product }
  | { status: "ambiguous"; query: string; candidates: ReturnType<typeof summarizeProduct>[] }
  | { status: "not_found"; query: string };

/** Pure: match `query` against an already-loaded catalog (so a multi-item order reads the catalog once). */
function matchProduct(query: string, products: Product[]): ProductMatch {
  const matches = findSimilarWithAliases(query, products, (p) => p.name, (p) => p.aliases, AMBIGUOUS_THRESHOLD);
  if (matches.length === 0) return { status: "not_found", query };
  const confident = pickConfident(query, matches, (p) => [p.name, ...p.aliases]);
  if (confident) return { status: "match", product: confident };
  // A short brand name ("coca") that only ONE product contains as words is that product, even though its score
  // stays below the auto-match cutoff because the catalog name is long.
  if (matches.length === 1 && [matches[0].item.name, ...matches[0].item.aliases].some((t) => wordMatchScore(query, t) > 0)) {
    return { status: "match", product: matches[0].item };
  }
  return {
    status: "ambiguous",
    query,
    candidates: matches.slice(0, 5).map((m) => ({ ...summarizeProduct(m.item), score: Math.round(m.score * 100) / 100 })),
  };
}

async function resolveProductMatch(query: string): Promise<ProductMatch> {
  return matchProduct(query, await getAllProducts());
}

type CustomerMatch =
  | { status: "match"; customer: Customer }
  | { status: "ambiguous"; query: string; candidates: ReturnType<typeof summarizeCustomer>[] }
  | { status: "not_found"; query: string };

async function resolveCustomerMatch(query: string): Promise<CustomerMatch> {
  const customers = await getAllCustomers();
  const matches = findSimilarWithAliases(query, customers, (c) => c.name, (c) => c.aliases, AMBIGUOUS_THRESHOLD);
  if (matches.length === 0) return { status: "not_found", query };
  const confident = pickConfident(query, matches, (c) => [c.name, ...c.aliases]);
  if (confident) return { status: "match", customer: confident };
  return {
    status: "ambiguous",
    query,
    candidates: matches.slice(0, 5).map((m) => ({ ...summarizeCustomer(m.item), score: Math.round(m.score * 100) / 100 })),
  };
}

/**
 * productId → price on this customer's most recent non-void, priced invoice containing it (first matching line within an
 * invoice). Built once from one history fetch instead of re-scanning every invoice per product.
 */
function buildLastPriceMap(customerInvoices: Invoice[]): Map<string, { price: number; unit: string }> {
  const map = new Map<string, { price: number; unit: string }>();
  // Open deliveries are skipped: their $0 "not priced yet" lines are not a price this customer paid.
  const relevant = customerInvoices.filter((i) => i.paymentStatus !== "void" && !isOpenDelivery(i)).sort((a, b) => b.createdAt - a.createdAt);
  for (const inv of relevant) {
    for (const line of inv.items) {
      if (line.productId && !map.has(line.productId)) map.set(line.productId, { price: line.price, unit: line.unit });
    }
  }
  return map;
}

async function getLastPriceForCustomerProduct(customerId: string, productId: string): Promise<number | null> {
  return buildLastPriceMap(await getInvoicesForCustomer(customerId)).get(productId)?.price ?? null;
}

function findLineIndex(invoice: Invoice, match: { productId?: string; productName?: string }): number {
  if (match.productId) {
    const idx = invoice.items.findIndex((it) => it.productId === match.productId);
    if (idx >= 0) return idx;
  }
  if (match.productName) {
    let best = -1;
    let bestScore = 0;
    invoice.items.forEach((it, idx) => {
      const score = similarity(match.productName as string, it.productName);
      if (score > bestScore) {
        bestScore = score;
        best = idx;
      }
    });
    if (bestScore >= AMBIGUOUS_THRESHOLD) return best;
  }
  return -1;
}

type ResolvedOrder = {
  customer: Customer;
  resolvedItems: InvoiceLineItem[];
  priceWarnings: string[];
  aliasSuggestions: AliasSuggestion[];
  /** Delivery mode: items given without a quantity (a delivery is never saved with quantity 0). */
  missingQuantity: string[];
};

/**
 * Matches the customer and every line of an order (shared by createInvoiceDraft and createDeliveryOrder). Returns
 * `early` when the order can't be resolved yet (ask the user / create the customer or product first).
 * "draft": a missing price falls back to last/default price, and anything still missing marks the line incomplete.
 * "delivery": only a stated price is used, else $0 (allowed for deliveries, not incomplete).
 */
async function resolveOrder(args: ToolArgs, ctx: ToolContext, mode: "draft" | "delivery"): Promise<{ early: unknown } | ResolvedOrder> {
  const rawItems = (args.items as Array<Record<string, unknown>>) ?? [];
  const readsStart = performance.now();
  // Every read this tool needs is done ONCE per execution (never once per line item) and never cached across
  // executions, so prices are always read fresh. The catalog load overlaps with customer resolution.
  const needsCatalog = rawItems.some((raw) => !raw.productId && raw.productName);
  const catalogRead = needsCatalog ? getAllProducts() : null;
  catalogRead?.catch(() => {}); // if we return early below, don't leave an unhandled rejection behind

  // Resolve customer.
  let customer: Customer | null = null;
  const aliasSuggestions: AliasSuggestion[] = [];
  if (args.customerId) {
    customer = await getCustomerById(String(args.customerId));
    if (!customer) return { early: { status: "error", message: "customerId not found." } };
  } else if (args.customerName) {
    const check = await resolveCustomerMatch(String(args.customerName));
    if (check.status === "match") {
      customer = check.customer;
      const suggestion = buildAliasSuggestion("customer", customer.id, customer.name, customer.aliases, String(args.customerName));
      if (suggestion) aliasSuggestions.push(suggestion);
    } else if (check.status === "ambiguous") {
      return { early: { status: "needs_confirmation", message: "Multiple customers look similar — ask which one.", candidates: check.candidates } };
    } else {
      return { early: { status: "needs_new_customer", message: `No customer found matching "${check.query}". Ask the user, then create it with createCustomer.`, query: check.query } };
    }
  } else {
    return { early: { status: "error", message: "Provide customerId or customerName." } };
  }

  if (rawItems.length === 0) return { early: { status: "error", message: "At least one line item is required." } };

  // One history fetch for this customer (all products' last prices come from it), plus unique product ids in a batch
  // when there is no catalog to look them up in.
  const uniqueIds = [...new Set(rawItems.filter((raw) => raw.productId).map((raw) => String(raw.productId)))];
  const [catalog, customerInvoices, fetchedById] = await Promise.all([
    catalogRead ?? Promise.resolve(null),
    getInvoicesForCustomer(customer.id),
    catalogRead ? Promise.resolve(null) : getProductsByIds(uniqueIds),
  ]);
  const productsById = new Map<string, Product>(fetchedById ?? []);
  if (catalog) for (const p of catalog) productsById.set(p.id, p);
  const lastPrices = buildLastPriceMap(customerInvoices);
  ctx.trace?.("draft_reads", performance.now() - readsStart, {
    catalogDocs: catalog?.length ?? 0,
    historyDocs: customerInvoices.length,
    items: rawItems.length,
  });

  const resolvedItems: InvoiceLineItem[] = [];
  const priceWarnings: string[] = [];
  const missingQuantity: string[] = [];

  for (const raw of rawItems) {
    const quantityGiven = raw.quantity !== undefined ? Number(raw.quantity) : undefined;
    // Treat a non-finite parse (e.g. Infinity) the same as "not given" — same graceful incomplete-draft path,
    // not a hard failure of the whole order. (quantityGiven <= 0 already catches negative and -Infinity; only
    // +Infinity needed this explicit check, since Infinity is truthy and Infinity <= 0 is false.)
    const quantityMissing = !quantityGiven || !Number.isFinite(quantityGiven) || quantityGiven <= 0;
    const quantity = quantityMissing ? 0 : (quantityGiven as number);

    let product: Product | null = null;
    if (raw.productId) {
      product = productsById.get(String(raw.productId)) ?? null;
      if (!product) return { early: { status: "error", message: `productId ${raw.productId} not found.` } };
    } else if (raw.productName) {
      const check = matchProduct(String(raw.productName), catalog!);
      if (check.status === "match") {
        product = check.product;
        const suggestion = buildAliasSuggestion("product", product.id, product.name, product.aliases, String(raw.productName));
        if (suggestion) aliasSuggestions.push(suggestion);
      } else if (check.status === "ambiguous") {
        return { early: {
          status: "needs_confirmation",
          message: `"${check.query}" matches multiple existing products — ask the user which one.`,
          candidates: check.candidates,
          resolvedSoFar: resolvedItems,
        } };
      } else {
        return { early: {
          status: "needs_new_product",
          message: `No product found matching "${check.query}". This may be a new item — confirm with the user, then create it with createProduct.`,
          query: check.query,
          resolvedSoFar: resolvedItems,
        } };
      }
    } else {
      return { early: { status: "error", message: "Each item needs productId or productName." } };
    }

    const lastSeen = lastPrices.get(product.id);
    // An old line saved without a unit was sold in the product's own unit.
    const lastLine = lastSeen ? { price: lastSeen.price, unit: lastSeen.unit || product.defaultUnit } : null;
    const lastPrice = lastLine?.price ?? null;
    // A price the app fills in is only valid for the unit it was charged in: "2 thùng" must not get the per-can price.
    const orderedUnit = typeof raw.unit === "string" && raw.unit.trim() ? raw.unit : null;
    const unitFits = (unit: string) => !orderedUnit || normalizeVN(orderedUnit) === normalizeVN(unit);
    let price: number;
    let priceMissing = false;
    if (mode === "delivery") {
      // Deliveries are priced later: only a price the user stated is used, otherwise $0 (not "incomplete").
      const given = raw.price !== undefined ? Number(raw.price) : NaN;
      price = Number.isFinite(given) && given >= 0 ? given : 0;
      if (raw.price !== undefined && lastLine && unitFits(lastLine.unit) && lastPrice !== null && Math.abs(lastPrice - price) > 0.01) {
        priceWarnings.push(`${product.name}: current order says $${price}, previous price for this customer was $${lastPrice}.`);
      }
    } else if (raw.price !== undefined) {
      price = Number(raw.price);
      if (lastLine && unitFits(lastLine.unit) && lastPrice !== null && Math.abs(lastPrice - price) > 0.01) {
        priceWarnings.push(`${product.name}: current order says $${price}, previous price for this customer was $${lastPrice}.`);
      }
    } else if (lastLine && unitFits(lastLine.unit)) {
      price = lastLine.price;
      priceWarnings.push(`${product.name}: no price given, used this customer's last price $${lastLine.price}.`);
    } else if (product.defaultPrice > 0 && unitFits(product.defaultUnit)) {
      price = product.defaultPrice;
      priceWarnings.push(`${product.name}: no price given, used catalog default $${product.defaultPrice}.`);
    } else if (lastLine || product.defaultPrice > 0) {
      price = 0;
      priceMissing = true;
      const knownUnit = lastLine ? lastLine.unit : product.defaultUnit;
      const knownPrice = lastLine ? lastLine.price : product.defaultPrice;
      priceWarnings.push(
        `${product.name}: ordered by "${orderedUnit}" but the known price is $${knownPrice} per "${knownUnit}" — saved as $0, needs a price per "${orderedUnit}" (or the quantity in "${knownUnit}"). Ask the user.`
      );
    } else {
      price = 0;
      priceMissing = true;
      priceWarnings.push(`${product.name}: no price given and no price history/default — saved as $0, needs a price.`);
    }

    const incomplete = quantityMissing || priceMissing;
    if (mode === "delivery" && quantityMissing) missingQuantity.push(product.name);
    if (quantityMissing) {
      priceWarnings.push(`${product.name}: no quantity given — saved with quantity 0, needs a quantity.`);
    }

    resolvedItems.push({
      productId: product.id,
      productName: product.name,
      quantity,
      unit: (raw.unit as string) || product.defaultUnit,
      price,
      lineTotal: Math.round(price * quantity * 100) / 100,
      barcode: product.barcode,
      ...(mode === "draft" ? { incomplete } : {}),
    });
  }
  return { customer, resolvedItems, priceWarnings, aliasSuggestions, missingQuantity };
}

/**
 * What a create tool WOULD save, for the outside-AI confirm step (ctx.previewOnly). `pinnedArgs` is the same order
 * with the matched customer and product ids filled in, so confirming saves exactly what was shown — the names are
 * not fuzzy-matched a second time. Quantities and stated prices are passed through unchanged (an unknown price stays
 * unknown, so an incomplete line is still incomplete when it is saved); for a draft, a price the app filled in from
 * the customer's last price or the catalog is pinned too.
 */
function orderPreview(args: ToolArgs, order: ResolvedOrder, mode: "draft" | "delivery", shipping: number, discount: number) {
  const rawItems = (args.items as Array<Record<string, unknown>>) ?? [];
  const { customer, resolvedItems, priceWarnings } = order;
  const pinnedItems = resolvedItems.map((it, i) => {
    const raw = rawItems[i] ?? {};
    const keepPrice = mode === "draft" && !it.incomplete ? it.price : raw.price;
    return {
      productId: it.productId,
      ...(raw.quantity !== undefined ? { quantity: raw.quantity } : {}),
      unit: it.unit,
      ...(keepPrice !== undefined ? { price: keepPrice } : {}),
    };
  });
  const { subtotal, total } = calcTotals(resolvedItems, shipping, discount);
  return {
    status: "preview",
    preview: {
      kind: mode === "draft" ? "invoice draft" : "delivery order",
      customer: { id: customer.id, name: customer.name },
      items: resolvedItems.map((it) => ({
        productId: it.productId,
        productName: it.productName,
        quantity: it.quantity,
        unit: it.unit,
        price: it.price,
        lineTotal: it.lineTotal,
        ...(it.incomplete ? { incomplete: true } : {}),
      })),
      shipping,
      discount,
      subtotal,
      total,
      priceWarnings,
      ...(mode === "draft"
        ? { incompleteItems: resolvedItems.filter((it) => it.incomplete).map((it) => it.productName) }
        : { unpricedItems: resolvedItems.filter((it) => it.price === 0).map((it) => it.productName) }),
    },
    pinnedArgs: {
      ...args,
      customerId: customer.id,
      customerName: undefined,
      shipping,
      ...(mode === "draft" ? { discount } : {}),
      items: pinnedItems,
      confirmed: undefined,
    },
  };
}

/* ------------------- product previews (outside-AI confirm step, ctx.previewOnly) ------------------- */

/** The product fields updateProduct may change, in the order a preview lists them. */
const PRODUCT_EDIT_FIELDS = ["name", "defaultUnit", "defaultPrice", "cost", "quantity", "category", "notes", "active"] as const;
const PRODUCT_AMOUNT_FIELDS = new Set(["defaultPrice", "cost", "quantity"]);
const PRICE_NOTE = "Only the product's default price changes. Invoices already made keep their prices.";

function productFieldValue(field: string, value: unknown): unknown {
  if (field === "active") return Boolean(value);
  if (PRODUCT_AMOUNT_FIELDS.has(field)) return Number(value);
  return String(value);
}

/**
 * What createProduct WOULD save. Runs the same checks as the real save (amounts, and the duplicate check above it),
 * so a confirm cannot fail on something the preview let through. force=true goes through with a warning listing
 * the similar products; confirming the preview is the person's explicit "yes, a new separate product".
 */
async function productCreatePreview(args: ToolArgs) {
  const name = String(args.name ?? "").trim();
  if (!name) return { status: "error", message: "A product needs a name." };
  if (args.defaultPrice === undefined) return { status: "needs_more_info", message: "What is the default price (USD)?" };
  const fields: Record<string, unknown> = { name };
  for (const field of ["defaultPrice", "cost", "quantity"] as const) {
    if (args[field] === undefined) continue;
    const value = Number(args[field]);
    assertNonNegativeAmount(value, field);
    fields[field] = value;
  }
  const aliases = (Array.isArray(args.aliases) ? args.aliases : []).map((a) => String(a).trim()).filter(Boolean);
  for (const field of ["category", "barcode", "notes"] as const) if (args[field]) fields[field] = String(args[field]);
  const check = await resolveProductMatch(name);
  const similar = check.status === "match" ? [summarizeProduct(check.product)] : check.status === "ambiguous" ? check.candidates : [];
  return {
    status: "preview",
    preview: {
      action: "Create a new product",
      product: { ...fields, defaultUnit: args.defaultUnit ? String(args.defaultUnit) : "unit", aliases, stockTracked: fields.quantity !== undefined },
      ...(similar.length > 0 ? { warning: "Similar products already exist. Saving makes a new, separate product.", similarProducts: similar } : {}),
    },
    pinnedArgs: { ...fields, ...(args.defaultUnit ? { defaultUnit: String(args.defaultUnit) } : {}), aliases, force: similar.length > 0 },
  };
}

/** What updateProduct WOULD change: each field as it is now and as it would be. Nothing on past invoices changes. */
async function productUpdatePreview(args: ToolArgs) {
  const product = await getProductById(String(args.productId));
  if (!product) return { status: "not_found", message: "Product not found." };
  const changes: { field: string; from: unknown; to: unknown }[] = [];
  const pinned: Record<string, unknown> = { productId: product.id };
  for (const field of PRODUCT_EDIT_FIELDS) {
    if (args[field] === undefined) continue;
    const to = productFieldValue(field, args[field]);
    if (field === "name" && !String(to).trim()) return { status: "error", message: "The name cannot be empty." };
    if (PRODUCT_AMOUNT_FIELDS.has(field)) assertNonNegativeAmount(to as number, field);
    const from = (product as unknown as Record<string, unknown>)[field] ?? null;
    if (from === to) continue;
    changes.push({ field, from, to });
    pinned[field] = to;
  }
  if (changes.length === 0) return { status: "unchanged", message: "Nothing to change: the product already has these values." };
  return {
    status: "preview",
    preview: {
      action: "Change a product",
      product: { id: product.id, name: product.name, unit: product.defaultUnit },
      changes,
      ...(changes.some((c) => c.field === "defaultPrice") ? { note: PRICE_NOTE } : {}),
    },
    pinnedArgs: pinned,
  };
}

/** What addProductAlias WOULD save, with a warning when the nickname already points at another product. */
async function productAliasPreview(args: ToolArgs) {
  const alias = String(args.alias ?? "").trim();
  if (!alias) return { status: "error", message: "The nickname is empty." };
  const products = await getAllProducts();
  const product = products.find((p) => p.id === String(args.productId));
  if (!product) return { status: "not_found", message: "Product not found." };
  if (product.aliases.some((a) => a.toLowerCase() === alias.toLowerCase())) {
    return { status: "unchanged", message: `"${alias}" is already a nickname of ${product.name}.` };
  }
  const others = findSimilarWithAliases(alias, products.filter((p) => p.id !== product.id), (p) => p.name, (p) => p.aliases, AUTO_MATCH_THRESHOLD);
  return {
    status: "preview",
    preview: {
      action: "Add a nickname to a product",
      product: { id: product.id, name: product.name, aliases: product.aliases },
      alias,
      ...(others.length > 0
        ? { warning: "This nickname also looks like other products; orders using it may need asking.", alsoMatches: others.slice(0, 3).map((m) => summarizeProduct(m.item)) }
        : {}),
    },
    pinnedArgs: { productId: product.id, alias },
  };
}

/**
 * Runs one tool. Business-rule failures (DomainError) of mutating tools come back as a normal `error`/`not_found`
 * result for the AI. Anything else (network, Firestore outage…) is rethrown so the job retries the SAME operation
 * id rather than telling the AI it failed and letting it try again under a new one.
 */
export async function executeTool(name: string, args: ToolArgs, ctx: ToolContext = {}): Promise<unknown> {
  try {
    return await runTool(name, args, ctx);
  } catch (err) {
    if (err instanceof NotFoundError) return { status: "not_found", message: err.message };
    if (err instanceof DomainError) return { status: "error", message: err.message };
    throw err;
  }
}

async function runTool(name: string, args: ToolArgs, ctx: ToolContext): Promise<unknown> {
  const operationId = ctx.operationId;
  switch (name) {
    case "searchProduct": {
      const products = await getAllProducts();
      const matches = findSimilarWithAliases(String(args.query), products, (p) => p.name, (p) => p.aliases, 0.3);
      return { results: matches.slice(0, 8).map((m) => ({ ...summarizeProduct(m.item), score: Math.round(m.score * 100) / 100, matchedOn: m.matchedOn, matchedText: m.matchedText })) };
    }

    case "getProduct": {
      const product = await getProductById(String(args.productId));
      return product ? { product } : { status: "not_found" };
    }

    case "createProduct": {
      const name_ = String(args.name);
      // An outside-AI preview may carry force=true: the person's confirm of that preview is the explicit "yes".
      if (!args.force || !(ctx.canConfirm || ctx.previewOnly)) {
        const check = await resolveProductMatch(name_);
        if (check.status !== "not_found") {
          return {
            status: "needs_confirmation",
            message: "A similar product already exists. Ask the user whether to use it, or create a new one with force=true.",
            ...(check.status === "match" ? { candidates: [summarizeProduct(check.product)] } : { candidates: check.candidates }),
          };
        }
      }
      if (ctx.previewOnly) return productCreatePreview(args);
      const product = await createProductDoc({
        name: name_,
        aliases: (args.aliases as string[]) ?? [],
        defaultUnit: args.defaultUnit ? String(args.defaultUnit) : undefined,
        defaultPrice: Number(args.defaultPrice),
        cost: args.cost !== undefined ? Number(args.cost) : undefined,
        quantity: args.quantity !== undefined ? Number(args.quantity) : undefined,
        category: args.category ? String(args.category) : undefined,
        barcode: args.barcode ? String(args.barcode) : undefined,
        notes: args.notes ? String(args.notes) : undefined,
        operationId,
      });
      return { status: "created", product };
    }

    case "updateProduct": {
      if (ctx.previewOnly) return productUpdatePreview(args);
      await updateProductDoc(String(args.productId), {
        ...(args.name !== undefined ? { name: String(args.name) } : {}),
        ...(args.defaultUnit !== undefined ? { defaultUnit: String(args.defaultUnit) } : {}),
        ...(args.defaultPrice !== undefined ? { defaultPrice: Number(args.defaultPrice) } : {}),
        ...(args.cost !== undefined ? { cost: Number(args.cost) } : {}),
        ...(args.quantity !== undefined ? { quantity: Number(args.quantity) } : {}),
        ...(args.category !== undefined ? { category: String(args.category) } : {}),
        ...(args.notes !== undefined ? { notes: String(args.notes) } : {}),
        ...(args.active !== undefined ? { active: Boolean(args.active) } : {}),
      }, operationId);
      return { status: "updated" };
    }

    case "addProductAlias": {
      if (ctx.previewOnly) return productAliasPreview(args);
      await addProductAliasDoc(String(args.productId), String(args.alias), operationId);
      return { status: "alias_added" };
    }

    case "searchCustomer": {
      const customers = await getAllCustomers();
      const matches = findSimilarWithAliases(String(args.query), customers, (c) => c.name, (c) => c.aliases, 0.3);
      return { results: matches.slice(0, 8).map((m) => ({ ...summarizeCustomer(m.item), score: Math.round(m.score * 100) / 100, matchedOn: m.matchedOn, matchedText: m.matchedText })) };
    }

    case "getCustomer": {
      const customer = await getCustomerById(String(args.customerId));
      return customer ? { customer } : { status: "not_found" };
    }

    case "createCustomer": {
      const name_ = String(args.name);
      if (!args.force || !ctx.canConfirm) {
        const check = await resolveCustomerMatch(name_);
        if (check.status !== "not_found") {
          return {
            status: "needs_confirmation",
            message: "A similar customer already exists. Ask the user whether to use it, or create a new one with force=true.",
            ...(check.status === "match" ? { candidates: [summarizeCustomer(check.customer)] } : { candidates: check.candidates }),
          };
        }
      }
      const customer = await createCustomerDoc({
        name: name_,
        aliases: (args.aliases as string[]) ?? [],
        contactName: args.contactName ? String(args.contactName) : undefined,
        phone: args.phone ? String(args.phone) : undefined,
        email: args.email ? String(args.email) : undefined,
        address: args.address ? String(args.address) : undefined,
        shippingAddress: args.shippingAddress ? String(args.shippingAddress) : undefined,
        notes: args.notes ? String(args.notes) : undefined,
        defaultShipping: args.defaultShipping !== undefined ? Number(args.defaultShipping) : undefined,
        operationId,
      });
      return { status: "created", customer };
    }

    case "updateCustomer": {
      await updateCustomerDoc(String(args.customerId), {
        ...(args.name !== undefined ? { name: String(args.name) } : {}),
        ...(args.contactName !== undefined ? { contactName: String(args.contactName) } : {}),
        ...(args.phone !== undefined ? { phone: String(args.phone) } : {}),
        ...(args.email !== undefined ? { email: String(args.email) } : {}),
        ...(args.address !== undefined ? { address: String(args.address) } : {}),
        ...(args.shippingAddress !== undefined ? { shippingAddress: String(args.shippingAddress) } : {}),
        ...(args.notes !== undefined ? { notes: String(args.notes) } : {}),
        ...(args.defaultShipping !== undefined ? { defaultShipping: Number(args.defaultShipping) } : {}),
        ...(args.active !== undefined ? { active: Boolean(args.active) } : {}),
      }, operationId);
      return { status: "updated" };
    }

    case "addCustomerAlias": {
      await addCustomerAliasDoc(String(args.customerId), String(args.alias), operationId);
      return { status: "alias_added" };
    }

    case "getLastPrice": {
      const price = await getLastPriceForCustomerProduct(String(args.customerId), String(args.productId));
      return price === null ? { status: "no_history" } : { price };
    }

    case "createInvoiceDraft": {
      const order = await resolveOrder(args, ctx, "draft");
      if ("early" in order) return order.early;
      const { customer, resolvedItems, priceWarnings, aliasSuggestions } = order;
      const shipping = args.shipping !== undefined ? Number(args.shipping) : customer.defaultShipping ?? 0;
      const discount = args.discount !== undefined ? Number(args.discount) : 0;
      if (ctx.previewOnly) return orderPreview(args, order, "draft", shipping, discount);

      const commitStart = performance.now();
      const invoice = await createInvoice({
        customerId: customer.id,
        customerName: customer.name,
        items: resolvedItems,
        shipping,
        discount,
        notes: args.notes ? String(args.notes) : undefined,
        originalOrderText: args.originalOrderText ? String(args.originalOrderText) : undefined,
        status: "draft",
        createdBy: "ai",
        actor: "ai",
        operationId,
      });
      ctx.trace?.("invoice_commit", performance.now() - commitStart, { items: resolvedItems.length });

      const incompleteItems = resolvedItems.filter((it) => it.incomplete).map((it) => it.productName);
      return {
        status: "created",
        invoice,
        priceWarnings,
        incompleteItems,
        ...(aliasSuggestions.length > 0 ? { aliasSuggestions } : {}),
        ...(incompleteItems.length > 0
          ? {
              message:
                "Saved as an INCOMPLETE temp draft because some items are missing quantity and/or price. Tell the user which item(s) need quantity/price, and that they should either provide the missing info (then use updateInvoiceItem to fill it in) or say if the order is wrong so you can delete it (updateInvoice with status=void).",
            }
          : {}),
      };
    }

    case "createDeliveryOrder": {
      const order = await resolveOrder(args, ctx, "delivery");
      if ("early" in order) return order.early;
      const { customer, resolvedItems, priceWarnings, aliasSuggestions, missingQuantity } = order;
      if (missingQuantity.length > 0) {
        return {
          status: "needs_more_info",
          message: `A delivery needs a quantity for every item. Ask the user how many: ${missingQuantity.join(", ")}.`,
          missingQuantity,
        };
      }
      const shipping = args.shipping !== undefined ? Number(args.shipping) : customer.defaultShipping ?? 0;
      if (ctx.previewOnly) return orderPreview(args, order, "delivery", shipping, 0);
      // Orders sent from Telegram are often typed in a hurry: show what was understood and save only after a "yes".
      if (ctx.channel === "telegram" && !(args.confirmed === true && ctx.canConfirm)) {
        return {
          status: "needs_confirmation",
          message:
            "Nothing saved yet. Show the user this delivery order (customer, each item with quantity and unit, any price she gave) and ask with requestUserInput whether to save it, using confirmChoices as the options. If she says yes, call createDeliveryOrder again with the same items and confirmed=true; if she wants changes, apply them and show the preview again.",
          preview: {
            customer: { id: customer.id, name: customer.name },
            items: resolvedItems.map((it) => ({ productId: it.productId, productName: it.productName, quantity: it.quantity, unit: it.unit, price: it.price })),
            shipping,
          },
          confirmChoices: ["Đúng, lưu đơn giao", "Sửa lại"],
          ...(aliasSuggestions.length > 0 ? { aliasSuggestions } : {}),
        };
      }
      const { stockWarnings, ...invoice } = await createInvoice({
        customerId: customer.id,
        customerName: customer.name,
        items: resolvedItems,
        shipping,
        discount: 0,
        notes: args.notes ? String(args.notes) : undefined,
        originalOrderText: args.originalOrderText ? String(args.originalOrderText) : undefined,
        status: "unpaid",
        delivery: { status: "open" },
        createdBy: "ai",
        actor: "ai",
        operationId,
      });
      const unpricedItems = resolvedItems.filter((it) => it.price === 0).map((it) => it.productName);
      return {
        status: "created",
        invoice,
        priceWarnings,
        unpricedItems,
        message: unpricedItems.length
          ? "Delivery order saved (unpaid, tagged Delivery). Items at $0 are fine for now — they get their price when the delivery is converted with convertDelivery."
          : "Delivery order saved (unpaid, tagged Delivery).",
        ...(stockWarnings ? { stockWarnings } : {}),
        ...(aliasSuggestions.length > 0 ? { aliasSuggestions } : {}),
      };
    }

    case "getDeliveries": {
      let customerId = args.customerId ? String(args.customerId) : undefined;
      if (!customerId && args.customerName) {
        const check = await resolveCustomerMatch(String(args.customerName));
        if (check.status === "ambiguous") return { status: "needs_confirmation", message: "Multiple customers look similar — ask which one.", candidates: check.candidates };
        if (check.status === "not_found") return { status: "not_found", message: `No customer found matching "${check.query}".` };
        customerId = check.customer.id;
      }
      const which = args.status === "converted" || args.status === "all" ? String(args.status) : "open";
      const invoices = customerId ? await getInvoicesForCustomer(customerId) : await getAllInvoices();
      const deliveries = invoices.filter(
        (i) => i.delivery && i.paymentStatus !== "void" && (which === "all" || i.delivery.status === which)
      );
      const quantityByProduct = new Map<string, { productName: string; unit: string; quantity: number }>();
      for (const d of deliveries) {
        for (const it of d.items) {
          const key = `${it.productId ?? it.productName}__${it.unit}`;
          const row = quantityByProduct.get(key) ?? { productName: it.productName, unit: it.unit, quantity: 0 };
          row.quantity += it.quantity;
          quantityByProduct.set(key, row);
        }
      }
      return {
        status: which,
        count: deliveries.length,
        ...(customerId ? { customerId } : {}),
        deliveries: deliveries.map((d) => ({
          id: d.id,
          invoiceNumber: d.invoiceNumber,
          date: d.date,
          customerId: d.customerId,
          customerName: d.customerName,
          deliveryStatus: d.delivery?.status,
          items: d.items.map((it) => ({ productId: it.productId, productName: it.productName, quantity: it.quantity, unit: it.unit, price: it.price })),
          unpricedItems: d.items.filter((it) => it.price === 0).map((it) => it.productName),
          total: d.total,
          balance: d.balance,
        })),
        quantityByProduct: [...quantityByProduct.values()],
      };
    }

    case "convertDelivery": {
      const target = args.invoiceId
        ? await getInvoiceDoc(String(args.invoiceId))
        : args.invoiceNumber
        ? await getInvoiceByNumber(String(args.invoiceNumber))
        : null;
      if (!target) return { status: "not_found", message: "Delivery order not found — give its invoiceId or invoiceNumber." };
      if (!target.delivery) return { status: "error", message: `Invoice #${target.invoiceNumber} is not a delivery order.` };
      const prices = Array.isArray(args.prices) ? (args.prices as Array<Record<string, unknown>>) : [];
      for (const p of prices) {
        const price = Number(p.price);
        if (!Number.isFinite(price) || price < 0) return { status: "needs_more_info", message: `Invalid price for ${p.productName ?? p.productId ?? "an item"} — ask the user.` };
      }
      const { stockWarnings, ...updated } = await updateInvoiceWithLog({
        invoiceId: target.id,
        items: (before) => {
          const items = before.items.map((it) => ({ ...it }));
          const priced = new Set<number>();
          for (const p of prices) {
            const idx = findLineIndex({ ...before, items }, { productId: p.productId as string | undefined, productName: p.productName as string | undefined });
            if (idx < 0) throw new DomainError(`"${p.productName ?? p.productId}" is not on delivery #${before.invoiceNumber}.`);
            items[idx].price = Number(p.price);
            items[idx].lineTotal = Math.round(items[idx].quantity * items[idx].price * 100) / 100;
            priced.add(idx);
          }
          const missing = items.filter((it, i) => it.price === 0 && !priced.has(i)).map((it) => it.productName);
          if (missing.length) throw new DomainError(`Still no price for: ${missing.join(", ")}. Ask the user for these prices (an explicit 0 is allowed for a free item).`);
          return items;
        },
        shipping: args.shipping !== undefined ? Number(args.shipping) : undefined,
        discount: args.discount !== undefined ? Number(args.discount) : undefined,
        convertDelivery: true, // checked inside the transaction, so a delivery is never converted twice
        actor: "ai",
        reason: String(args.reason ?? `Delivery #${target.invoiceNumber} converted to final invoice`),
        operationId,
      });
      return { status: "converted", invoice: updated, ...(stockWarnings ? { stockWarnings } : {}) };
    }

    case "getInvoice": {
      if (args.invoiceId) {
        const invoice = await getInvoiceDoc(String(args.invoiceId));
        return invoice ? { invoice } : { status: "not_found" };
      }
      if (args.invoiceNumber) {
        const invoice = await getInvoiceByNumber(String(args.invoiceNumber));
        return invoice ? { invoice } : { status: "not_found" };
      }
      return { status: "error", message: "Provide invoiceId or invoiceNumber." };
    }

    case "searchInvoices": {
      const invoices = await getAllInvoices();
      let results = invoices;
      if (args.customerId) results = results.filter((i) => i.customerId === args.customerId);
      if (args.status) results = results.filter((i) => i.paymentStatus === args.status);
      if (args.text) {
        const text = String(args.text).toLowerCase();
        results = results.filter(
          (i) => i.invoiceNumber.toLowerCase().includes(text) || similarity(text, i.customerName) > 0.5
        );
      }
      const limit = args.limit ? Number(args.limit) : 20;
      return { results: results.slice(0, limit) };
    }

    case "getCustomerInvoices": {
      const invoices = await getAllInvoices();
      return { results: invoices.filter((i) => i.customerId === args.customerId) };
    }

    case "getCustomerDebt": {
      return getCustomerDebtDoc(String(args.customerId));
    }

    case "getUnpaidInvoices": {
      const results = await getUnpaidInvoicesDoc(args.status as InvoiceStatus | undefined);
      return { results };
    }

    case "addInvoiceItem": {
      const invoice = await getInvoiceDoc(String(args.invoiceId));
      if (!invoice) return { status: "not_found" };

      let product: Product | null = null;
      let aliasSuggestion: AliasSuggestion | null = null;
      if (args.productId) product = await getProductById(String(args.productId));
      else if (args.productName) {
        const check = await resolveProductMatch(String(args.productName));
        if (check.status === "match") {
          product = check.product;
          aliasSuggestion = buildAliasSuggestion("product", product.id, product.name, product.aliases, String(args.productName));
        } else if (check.status === "ambiguous") return { status: "needs_confirmation", candidates: check.candidates };
        else return { status: "needs_new_product", query: check.query };
      }
      if (!product) return { status: "error", message: "Provide productId or productName." };
      const chosen = product;

      // Never guess: a missing/invalid quantity or a missing price with no catalog default must be asked, not assumed.
      const quantity = Number(args.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return { status: "needs_more_info", message: `Quantity for ${chosen.name} is missing or invalid — ask the user.` };
      }
      // An open delivery is priced later: a missing price is $0 there, never a guessed default.
      const delivery = isOpenDelivery(invoice);
      const price = args.price !== undefined ? Number(args.price) : delivery ? 0 : chosen.defaultPrice;
      if (!Number.isFinite(price) || price < 0 || (price === 0 && !delivery)) {
        return { status: "needs_more_info", message: `No price given and ${chosen.name} has no default price — ask the user for the price.` };
      }

      // The line list is computed from the invoice as read INSIDE the transaction, so a concurrent edit is never overwritten.
      const { stockWarnings, ...updated } = await updateInvoiceWithLog({
        invoiceId: invoice.id,
        items: (before) => {
          const items = [...before.items];
          const existingIdx = items.findIndex((it) => it.productId === chosen.id);
          if (existingIdx >= 0) {
            const merged = { ...items[existingIdx] };
            merged.quantity += quantity;
            merged.lineTotal = Math.round(merged.quantity * merged.price * 100) / 100;
            items[existingIdx] = merged;
          } else {
            items.push({
              productId: chosen.id,
              productName: chosen.name,
              quantity,
              unit: (args.unit as string) || chosen.defaultUnit,
              price,
              lineTotal: Math.round(quantity * price * 100) / 100,
              barcode: chosen.barcode,
            });
          }
          return items;
        },
        actor: "ai",
        reason: String(args.reason ?? `Added ${quantity} x ${chosen.name}`),
        operationId,
      });
      return { status: "updated", invoice: updated, ...(stockWarnings ? { stockWarnings } : {}), ...(aliasSuggestion ? { aliasSuggestions: [aliasSuggestion] } : {}) };
    }

    case "updateInvoiceItem": {
      const { stockWarnings, ...updated } = await updateInvoiceWithLog({
        invoiceId: String(args.invoiceId),
        items: (before) => {
          const idx = findLineIndex(before, { productId: args.productId as string, productName: args.productName as string });
          if (idx < 0) throw new DomainError("Could not find that line item on the invoice.");
          const items = [...before.items];
          const line = { ...items[idx] };
          if (args.quantity !== undefined) line.quantity = Number(args.quantity);
          if (args.price !== undefined) line.price = Number(args.price);
          if (args.unit !== undefined) line.unit = String(args.unit);
          line.lineTotal = Math.round(line.quantity * line.price * 100) / 100;
          items[idx] = line;
          return items;
        },
        actor: "ai",
        reason: String(args.reason ?? `Updated ${args.productName ?? "line item"}`),
        operationId,
      });
      return { status: "updated", invoice: updated, ...(stockWarnings ? { stockWarnings } : {}) };
    }

    case "removeInvoiceItem": {
      const { stockWarnings, ...updated } = await updateInvoiceWithLog({
        invoiceId: String(args.invoiceId),
        items: (before) => {
          const idx = findLineIndex(before, { productId: args.productId as string, productName: args.productName as string });
          if (idx < 0) throw new DomainError("Could not find that line item on the invoice.");
          return before.items.filter((_, i) => i !== idx);
        },
        actor: "ai",
        reason: String(args.reason ?? `Removed ${args.productName ?? "line item"}`),
        operationId,
      });
      return { status: "updated", invoice: updated, ...(stockWarnings ? { stockWarnings } : {}) };
    }

    case "updateInvoice": {
      const { stockWarnings, ...updated } = await updateInvoiceWithLog({
        invoiceId: String(args.invoiceId),
        shipping: args.shipping !== undefined ? Number(args.shipping) : undefined,
        discount: args.discount !== undefined ? Number(args.discount) : undefined,
        status: args.status as InvoiceStatus | undefined,
        notes: args.notes !== undefined ? String(args.notes) : undefined,
        customerId: args.customerId !== undefined ? String(args.customerId) : undefined,
        customerName: args.customerName !== undefined ? String(args.customerName) : undefined,
        actor: "ai",
        reason: String(args.reason ?? "Updated by AI assistant"),
        operationId,
      });
      return { status: "updated", invoice: updated, ...(stockWarnings ? { stockWarnings } : {}) };
    }

    case "finalizeInvoice": {
      const { stockWarnings, ...updated } = await updateInvoiceWithLog({
        invoiceId: String(args.invoiceId),
        status: "unpaid",
        actor: "ai",
        reason: "Invoice finalized",
        operationId,
      });
      return { status: "finalized", invoice: updated, ...(stockWarnings ? { stockWarnings } : {}) };
    }

    case "copyInvoice": {
      const source = args.invoiceId
        ? await getInvoiceDoc(String(args.invoiceId))
        : args.invoiceNumber
        ? await getInvoiceByNumber(String(args.invoiceNumber))
        : null;
      if (!source) return { status: "not_found" };
      const invoice = await copyInvoiceDoc({ sourceInvoiceId: source.id, actor: "ai", operationId });
      return { status: "created", invoice };
    }

    case "recordPayment": {
      const amount = Number(args.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        return { status: "needs_more_info", message: "Payment amount must be a positive number — ask the user for the amount." };
      }
      const { invoice, payment, stockWarnings } = await recordPaymentDoc({
        invoiceId: String(args.invoiceId),
        amount,
        method: args.method ? String(args.method) : undefined,
        note: args.note ? String(args.note) : undefined,
        actor: "ai",
        operationId,
      });
      return { status: "recorded", invoice, payment, ...(stockWarnings ? { stockWarnings } : {}) };
    }

    case "searchPayments": {
      const payments = await getAllPayments();
      let results = payments;
      if (args.invoiceId) results = results.filter((p) => p.invoiceId === args.invoiceId);
      if (args.customerId) results = results.filter((p) => p.customerId === args.customerId);
      return { results };
    }

    default:
      return { status: "error", message: `Unknown tool: ${name}` };
  }
}

