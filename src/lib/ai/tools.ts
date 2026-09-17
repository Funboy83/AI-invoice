import { findSimilarWithAliases, similarity } from "@/lib/similarity";
import {
  getAllProducts,
  getProductById,
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
  getCustomerDebt as getCustomerDebtDoc,
  getUnpaidInvoices as getUnpaidInvoicesDoc,
} from "@/lib/store";
import type { Customer, Invoice, InvoiceLineItem, InvoiceStatus, Product } from "@/lib/types";

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
    description: "Update fields of an existing product (name, price, unit, category, cost, notes, active).",
    input_schema: {
      type: "object" as const,
      properties: {
        productId: { type: "string" },
        name: { type: "string" },
        defaultUnit: { type: "string" },
        defaultPrice: { type: "number" },
        cost: { type: "number" },
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
      "Create a new DRAFT invoice for a customer with one or more line items, parsed from a (possibly messy Vietnamese) order message. Each item is matched against the product catalog by name/alias. If a customer or product doesn't clearly match, this returns needs_confirmation/needs_new_customer/needs_new_product and you must resolve it (ask the user, or create the entity) before retrying. Quantity is always required; price falls back to last price charged to this customer, then the product default price, with a warning if ambiguous — application code always computes totals, never trust your own math.",
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
              quantity: { type: "number" },
              unit: { type: "string" },
              price: { type: "number" },
            },
            required: ["quantity"],
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
    name: "searchPayments",
    description: "List recorded payments, optionally filtered by invoice or customer.",
    input_schema: {
      type: "object" as const,
      properties: { invoiceId: { type: "string" }, customerId: { type: "string" } },
    },
  },
];

type ToolArgs = Record<string, unknown>;

/** Confident match cutoff for auto-using a product/customer without asking. */
const AUTO_MATCH_THRESHOLD = 0.82;
const AMBIGUOUS_THRESHOLD = 0.55;

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

async function resolveProductMatch(query: string): Promise<ProductMatch> {
  const products = await getAllProducts();
  const matches = findSimilarWithAliases(query, products, (p) => p.name, (p) => p.aliases, AMBIGUOUS_THRESHOLD);
  if (matches.length === 0) return { status: "not_found", query };
  if (matches[0].score >= AUTO_MATCH_THRESHOLD) return { status: "match", product: matches[0].item };
  return {
    status: "ambiguous",
    query,
    candidates: matches.slice(0, 5).map((m) => ({ ...summarizeProduct(m.item), score: Math.round(m.score * 100) / 100 })),
  };
}

type CustomerMatch =
  | { status: "match"; customer: Customer }
  | { status: "ambiguous"; query: string; candidates: ReturnType<typeof summarizeCustomer>[] }
  | { status: "not_found"; query: string };

async function resolveCustomerMatch(query: string): Promise<CustomerMatch> {
  const customers = await getAllCustomers();
  const matches = findSimilarWithAliases(query, customers, (c) => c.name, (c) => c.aliases, AMBIGUOUS_THRESHOLD);
  if (matches.length === 0) return { status: "not_found", query };
  if (matches[0].score >= AUTO_MATCH_THRESHOLD) return { status: "match", customer: matches[0].item };
  return {
    status: "ambiguous",
    query,
    candidates: matches.slice(0, 5).map((m) => ({ ...summarizeCustomer(m.item), score: Math.round(m.score * 100) / 100 })),
  };
}

async function getLastPriceForCustomerProduct(customerId: string, productId: string): Promise<number | null> {
  const invoices = await getAllInvoices();
  const relevant = invoices
    .filter((i) => i.customerId === customerId && i.paymentStatus !== "void")
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const inv of relevant) {
    const line = inv.items.find((it) => it.productId === productId);
    if (line) return line.price;
  }
  return null;
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

export async function executeTool(name: string, args: ToolArgs): Promise<unknown> {
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
      if (!args.force) {
        const check = await resolveProductMatch(name_);
        if (check.status !== "not_found") {
          return {
            status: "needs_confirmation",
            message: "A similar product already exists. Ask the user whether to use it, or create a new one with force=true.",
            ...(check.status === "match" ? { candidates: [summarizeProduct(check.product)] } : { candidates: check.candidates }),
          };
        }
      }
      const product = await createProductDoc({
        name: name_,
        aliases: (args.aliases as string[]) ?? [],
        defaultUnit: args.defaultUnit ? String(args.defaultUnit) : undefined,
        defaultPrice: Number(args.defaultPrice),
        cost: args.cost !== undefined ? Number(args.cost) : undefined,
        category: args.category ? String(args.category) : undefined,
        barcode: args.barcode ? String(args.barcode) : undefined,
        notes: args.notes ? String(args.notes) : undefined,
      });
      return { status: "created", product };
    }

    case "updateProduct": {
      await updateProductDoc(String(args.productId), {
        ...(args.name !== undefined ? { name: String(args.name) } : {}),
        ...(args.defaultUnit !== undefined ? { defaultUnit: String(args.defaultUnit) } : {}),
        ...(args.defaultPrice !== undefined ? { defaultPrice: Number(args.defaultPrice) } : {}),
        ...(args.cost !== undefined ? { cost: Number(args.cost) } : {}),
        ...(args.category !== undefined ? { category: String(args.category) } : {}),
        ...(args.notes !== undefined ? { notes: String(args.notes) } : {}),
        ...(args.active !== undefined ? { active: Boolean(args.active) } : {}),
      });
      return { status: "updated" };
    }

    case "addProductAlias": {
      await addProductAliasDoc(String(args.productId), String(args.alias));
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
      if (!args.force) {
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
      });
      return { status: "updated" };
    }

    case "addCustomerAlias": {
      await addCustomerAliasDoc(String(args.customerId), String(args.alias));
      return { status: "alias_added" };
    }

    case "getLastPrice": {
      const price = await getLastPriceForCustomerProduct(String(args.customerId), String(args.productId));
      return price === null ? { status: "no_history" } : { price };
    }

    case "createInvoiceDraft": {
      // Resolve customer.
      let customer: Customer | null = null;
      if (args.customerId) {
        customer = await getCustomerById(String(args.customerId));
        if (!customer) return { status: "error", message: "customerId not found." };
      } else if (args.customerName) {
        const check = await resolveCustomerMatch(String(args.customerName));
        if (check.status === "match") customer = check.customer;
        else if (check.status === "ambiguous") {
          return { status: "needs_confirmation", message: "Multiple customers look similar — ask which one.", candidates: check.candidates };
        } else {
          return { status: "needs_new_customer", message: `No customer found matching "${check.query}". Ask the user, then create it with createCustomer.`, query: check.query };
        }
      } else {
        return { status: "error", message: "Provide customerId or customerName." };
      }

      const rawItems = (args.items as Array<Record<string, unknown>>) ?? [];
      if (rawItems.length === 0) return { status: "error", message: "At least one line item is required." };

      const resolvedItems: InvoiceLineItem[] = [];
      const priceWarnings: string[] = [];

      for (const raw of rawItems) {
        const quantity = raw.quantity !== undefined ? Number(raw.quantity) : undefined;
        if (!quantity || quantity <= 0) {
          return {
            status: "needs_more_info",
            message: `Missing or invalid quantity for "${raw.productName ?? raw.productId}". Ask the user for the quantity.`,
            resolvedSoFar: resolvedItems,
          };
        }

        let product: Product | null = null;
        if (raw.productId) {
          product = await getProductById(String(raw.productId));
          if (!product) return { status: "error", message: `productId ${raw.productId} not found.` };
        } else if (raw.productName) {
          const check = await resolveProductMatch(String(raw.productName));
          if (check.status === "match") product = check.product;
          else if (check.status === "ambiguous") {
            return {
              status: "needs_confirmation",
              message: `"${check.query}" matches multiple existing products — ask the user which one.`,
              candidates: check.candidates,
              resolvedSoFar: resolvedItems,
            };
          } else {
            return {
              status: "needs_new_product",
              message: `No product found matching "${check.query}". This may be a new item — confirm with the user, then create it with createProduct.`,
              query: check.query,
              resolvedSoFar: resolvedItems,
            };
          }
        } else {
          return { status: "error", message: "Each item needs productId or productName." };
        }

        const lastPrice = customer ? await getLastPriceForCustomerProduct(customer.id, product.id) : null;
        let price: number;
        if (raw.price !== undefined) {
          price = Number(raw.price);
          if (lastPrice !== null && Math.abs(lastPrice - price) > 0.01) {
            priceWarnings.push(`${product.name}: current order says $${price}, previous price for this customer was $${lastPrice}.`);
          }
        } else if (lastPrice !== null) {
          price = lastPrice;
          priceWarnings.push(`${product.name}: no price given, used this customer's last price $${lastPrice}.`);
        } else {
          price = product.defaultPrice;
          priceWarnings.push(`${product.name}: no price given, used catalog default $${product.defaultPrice}.`);
        }

        resolvedItems.push({
          productId: product.id,
          productName: product.name,
          quantity,
          unit: (raw.unit as string) || product.defaultUnit,
          price,
          lineTotal: Math.round(price * quantity * 100) / 100,
          barcode: product.barcode,
        });
      }

      const invoice = await createInvoice({
        customerId: customer.id,
        customerName: customer.name,
        items: resolvedItems,
        shipping: args.shipping !== undefined ? Number(args.shipping) : customer.defaultShipping ?? 0,
        discount: args.discount !== undefined ? Number(args.discount) : 0,
        notes: args.notes ? String(args.notes) : undefined,
        originalOrderText: args.originalOrderText ? String(args.originalOrderText) : undefined,
        status: "draft",
        createdBy: "ai",
        actor: "ai",
      });

      return { status: "created", invoice, priceWarnings };
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
      if (args.productId) product = await getProductById(String(args.productId));
      else if (args.productName) {
        const check = await resolveProductMatch(String(args.productName));
        if (check.status === "match") product = check.product;
        else if (check.status === "ambiguous") return { status: "needs_confirmation", candidates: check.candidates };
        else return { status: "needs_new_product", query: check.query };
      }
      if (!product) return { status: "error", message: "Provide productId or productName." };

      const quantity = Number(args.quantity);
      const price = args.price !== undefined ? Number(args.price) : product.defaultPrice;
      const existingIdx = invoice.items.findIndex((it) => it.productId === product!.id);
      const items = [...invoice.items];
      if (existingIdx >= 0) {
        const merged = { ...items[existingIdx] };
        merged.quantity += quantity;
        merged.lineTotal = Math.round(merged.quantity * merged.price * 100) / 100;
        items[existingIdx] = merged;
      } else {
        items.push({
          productId: product.id,
          productName: product.name,
          quantity,
          unit: (args.unit as string) || product.defaultUnit,
          price,
          lineTotal: Math.round(quantity * price * 100) / 100,
          barcode: product.barcode,
        });
      }

      const updated = await updateInvoiceWithLog({
        invoiceId: invoice.id,
        items,
        actor: "ai",
        reason: String(args.reason ?? `Added ${quantity} x ${product.name}`),
      });
      return { status: "updated", invoice: updated };
    }

    case "updateInvoiceItem": {
      const invoice = await getInvoiceDoc(String(args.invoiceId));
      if (!invoice) return { status: "not_found" };
      const idx = findLineIndex(invoice, { productId: args.productId as string, productName: args.productName as string });
      if (idx < 0) return { status: "error", message: "Could not find that line item on the invoice." };

      const items = [...invoice.items];
      const line = { ...items[idx] };
      if (args.quantity !== undefined) line.quantity = Number(args.quantity);
      if (args.price !== undefined) line.price = Number(args.price);
      if (args.unit !== undefined) line.unit = String(args.unit);
      line.lineTotal = Math.round(line.quantity * line.price * 100) / 100;
      items[idx] = line;

      const updated = await updateInvoiceWithLog({
        invoiceId: invoice.id,
        items,
        actor: "ai",
        reason: String(args.reason ?? `Updated ${line.productName}`),
      });
      return { status: "updated", invoice: updated };
    }

    case "removeInvoiceItem": {
      const invoice = await getInvoiceDoc(String(args.invoiceId));
      if (!invoice) return { status: "not_found" };
      const idx = findLineIndex(invoice, { productId: args.productId as string, productName: args.productName as string });
      if (idx < 0) return { status: "error", message: "Could not find that line item on the invoice." };
      const removed = invoice.items[idx];
      const items = invoice.items.filter((_, i) => i !== idx);

      const updated = await updateInvoiceWithLog({
        invoiceId: invoice.id,
        items,
        actor: "ai",
        reason: String(args.reason ?? `Removed ${removed.productName}`),
      });
      return { status: "updated", invoice: updated };
    }

    case "updateInvoice": {
      const updated = await updateInvoiceWithLog({
        invoiceId: String(args.invoiceId),
        shipping: args.shipping !== undefined ? Number(args.shipping) : undefined,
        discount: args.discount !== undefined ? Number(args.discount) : undefined,
        status: args.status as InvoiceStatus | undefined,
        notes: args.notes !== undefined ? String(args.notes) : undefined,
        customerId: args.customerId !== undefined ? String(args.customerId) : undefined,
        customerName: args.customerName !== undefined ? String(args.customerName) : undefined,
        actor: "ai",
        reason: String(args.reason ?? "Updated by AI assistant"),
      });
      return { status: "updated", invoice: updated };
    }

    case "finalizeInvoice": {
      const updated = await updateInvoiceWithLog({
        invoiceId: String(args.invoiceId),
        status: "unpaid",
        actor: "ai",
        reason: "Invoice finalized",
      });
      return { status: "finalized", invoice: updated };
    }

    case "copyInvoice": {
      const source = args.invoiceId
        ? await getInvoiceDoc(String(args.invoiceId))
        : args.invoiceNumber
        ? await getInvoiceByNumber(String(args.invoiceNumber))
        : null;
      if (!source) return { status: "not_found" };
      const invoice = await copyInvoiceDoc({ sourceInvoiceId: source.id, actor: "ai" });
      return { status: "created", invoice };
    }

    case "recordPayment": {
      const { invoice, payment } = await recordPaymentDoc({
        invoiceId: String(args.invoiceId),
        amount: Number(args.amount),
        method: args.method ? String(args.method) : undefined,
        note: args.note ? String(args.note) : undefined,
        actor: "ai",
      });
      return { status: "recorded", invoice, payment };
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

