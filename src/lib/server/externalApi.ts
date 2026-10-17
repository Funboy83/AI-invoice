import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getAdminDb } from "./firebaseAdmin";
import { HttpError, currentStoreId, type AuthedUser } from "./auth";
import { memberByEmail } from "./membership";
import { executeTool, toolDefinitions } from "@/lib/ai/tools";
import { adminToolDefinitions, adminToolNames, runAdminTool } from "./adminTools";
import { getAllCustomers } from "./businessStore";
import { getPurchase, getVendor } from "./purchaseStore";
import { workerBaseUrl } from "./dispatch";

/**
 * The door for OUTSIDE AI apps (Claude, ChatGPT, or a script) — used by the REST API (/api/v1/tools) and the MCP
 * server (/api/mcp). It is a thin layer over the SAME tools the in-app chat and Telegram use (src/lib/ai/tools.ts):
 * one set of business rules, one database, one audit log. Nothing here does its own money math.
 *
 * Off unless AI_API_ENABLED=true. Who may use it: AI_API_KEYS = "appLoginEmail:secretKey, …" — each key belongs to an
 * existing app member (storeMembers), checked live on every call, so removing the member also cuts off the key.
 *
 * What it can do: everything the app's own pages can do, like an admin (the owner asked for this on 2026-10-17;
 * docs/OPERATING_POLICY.md rule 5 records it). Reads run straight away. EVERY write (orders, invoice edits and voids,
 * delivery pricing, customer and vendor payments, customers, products, vendors, purchases, cancelling a purchase,
 * Custom Invoice info) goes in two steps: the call only PREVIEWS (nothing is saved) and returns a one-time confirm
 * token; `confirmAction` with that token saves exactly what was previewed, through the same store functions the app
 * uses, so its rules (totals, no overpaying, duplicate vendor invoice #, stock) still apply.
 * Never exposed: permanently deleting anything (the app has no delete either), and the chat-only requestUserInput.
 *
 * RULE FOR NEW FEATURES: a feature that adds something people can do in the app ships with its tools here
 * (see CONTRIBUTING.md), or outside AI apps silently can't do it.
 */

export interface ApiConfig {
  /** One entry per key. */
  keys: { email: string; key: string }[];
}

/** A key must be long and random; shorter ones are ignored so a weak key can never open the door. */
const MIN_KEY_LENGTH = 32;

export function apiConfig(env: Record<string, string | undefined> = process.env): ApiConfig | null {
  if (env.AI_API_ENABLED?.trim().toLowerCase() !== "true") return null;
  const keys = parseApiKeys(env.AI_API_KEYS ?? "");
  return keys.length > 0 ? { keys } : null;
}

/**
 * Why the door is still closed although AI_API_ENABLED=true (a mistyped AI_API_KEYS), or null. Routes answer 503 with
 * this message instead of a bare 404, so a setup mistake is visible from the outside without revealing any key.
 */
export function apiConfigProblem(env: Record<string, string | undefined> = process.env): string | null {
  if (env.AI_API_ENABLED?.trim().toLowerCase() !== "true") return null;
  if (!env.AI_API_KEYS?.trim()) return "AI_API_ENABLED is true but AI_API_KEYS is empty. Set it to loginEmail:key in Vercel and redeploy.";
  if (parseApiKeys(env.AI_API_KEYS).length === 0) {
    return "AI_API_KEYS has no valid entry. Use loginEmail:key (key: 32+ letters, digits, - or _; no spaces, no 'Bearer'), then redeploy.";
  }
  return null;
}

/** "a@b.com:KEY, c@d.com:KEY2" → entries. Malformed or short entries are ignored (never widen access by accident). */
export function parseApiKeys(raw: string): { email: string; key: string }[] {
  const out: { email: string; key: string }[] = [];
  // Surrounding quotes are a common copy-paste leftover in the Vercel dashboard; they are never part of a key.
  for (const entry of raw.trim().replace(/^(["'])([^]*)\1$/, "$2").split(/[,;\n]/)) {
    const m = /^\s*([^\s:]+@[^\s:]+)\s*:\s*([A-Za-z0-9_-]+)\s*$/.exec(entry);
    if (m && m[2].length >= MIN_KEY_LENGTH) out.push({ email: m[1].toLowerCase(), key: m[2] });
  }
  return out;
}

/** The key from `Authorization: Bearer …` or `X-API-Key`, else the one in the URL path (for apps that can't send headers). */
export function keyFromRequest(req: Request, pathKey?: string): string {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const header = req.headers.get("x-api-key");
  if (header) return header.trim();
  return (pathKey ?? "").trim();
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Which configured key this is (constant-time against every entry), then a live store-membership check. */
export async function authenticateApiKey(cfg: ApiConfig, given: string): Promise<AuthedUser> {
  if (!given) throw new HttpError(401, "Missing API key.");
  const givenDigest = digest(given);
  let email: string | null = null;
  for (const entry of cfg.keys) {
    if (timingSafeEqual(givenDigest, digest(entry.key)) && email === null) email = entry.email;
  }
  if (!email) throw new HttpError(401, "Invalid API key.");
  const member = await memberByEmail(getAdminDb(), email, currentStoreId());
  if (!member) throw new HttpError(403, "This key's account is not a member of the store.");
  return member;
}

/* --------------------------------- tool catalog --------------------------------- */

const READ_TOOLS = [
  "searchCustomer",
  "getCustomer",
  "searchProduct",
  "getProduct",
  "getLastPrice",
  "getInvoice",
  "searchInvoices",
  "getCustomerInvoices",
  "getCustomerDebt",
  "getUnpaidInvoices",
  "getDeliveries",
  "searchPayments",
] as const;

/** Chat tools that change data: outside apps get them through preview → confirmAction. */
const CHAT_WRITE_TOOLS = [
  "createInvoiceDraft",
  "createDeliveryOrder",
  "addInvoiceItem",
  "updateInvoiceItem",
  "removeInvoiceItem",
  "updateInvoice",
  "finalizeInvoice",
  "copyInvoice",
  "convertDelivery",
  "recordPayment",
  "createCustomer",
  "updateCustomer",
  "addCustomerAlias",
  "createProduct",
  "updateProduct",
  "addProductAlias",
] as const;
const ADMIN_WRITE_TOOLS = adminToolDefinitions.filter((t) => !t.readOnly).map((t) => t.name);
const CONFIRM_TOOLS: readonly string[] = [...CHAT_WRITE_TOOLS, ...ADMIN_WRITE_TOOLS];

export const CONFIRM_ACTION = "confirmAction";
/** ChatGPT's connectors (outside Developer mode, and deep research) only use tools with exactly these two names. */
const SEARCH = "search";
const FETCH = "fetch";
const PENDING_COLLECTION = "apiPendingActions";
const PENDING_TTL_MS = 30 * 60 * 1000;

export interface ExternalTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

const CONFIRM_NOTE =
  " OUTSIDE-APP RULE: this call only PREVIEWS — nothing is saved. It returns status needs_confirmation with the preview (what will be saved or changed, money before and after, and any warnings) and a confirmToken. Show the preview to the person and call confirmAction with the token only after they say yes. If they want changes, call this tool again with the corrected details to get a new preview.";

/** Chat wording about asking with requestUserInput / confirmed=true doesn't apply here (confirmAction does that). */
function outsideDescription(description: string): string {
  return description
    .split(/(?<=\.)\s+/)
    .filter((sentence) => !/requestUserInput|confirmed=true|In the chat|Nothing is saved on the first call/.test(sentence))
    .join(" ")
    .replace(/ If the result is needs_confirmation with a preview[^]*$/, "");
}

function stripProperty(schema: Record<string, unknown>, prop: string): Record<string, unknown> {
  const properties = { ...(schema.properties as Record<string, unknown>) };
  delete properties[prop];
  return { ...schema, properties };
}

function buildCatalog(): ExternalTool[] {
  const byName = new Map(toolDefinitions.map((t) => [t.name, t]));
  const out: ExternalTool[] = [];
  for (const name of READ_TOOLS) {
    const t = byName.get(name)!;
    out.push({ name, description: t.description, inputSchema: t.input_schema as Record<string, unknown>, readOnly: true });
  }
  for (const t of adminToolDefinitions.filter((d) => d.readOnly)) {
    out.push({ name: t.name, description: t.description, inputSchema: t.input_schema, readOnly: true });
  }
  for (const name of CHAT_WRITE_TOOLS) {
    const t = byName.get(name)!;
    // The chat-only `confirmed` flag means nothing here: confirming is done with confirmAction's token.
    let schema = stripProperty(t.input_schema as Record<string, unknown>, "confirmed");
    if (name === "createInvoiceDraft") {
      schema = {
        ...schema,
        properties: {
          ...(schema.properties as Record<string, unknown>),
          finalize: { type: "boolean", description: "Save it as a finished (unpaid) invoice instead of a draft, like the app's New invoice form. Every item then needs a quantity and a price." },
        },
      };
    }
    out.push({ name, description: outsideDescription(t.description) + CONFIRM_NOTE, inputSchema: schema, readOnly: false });
  }
  for (const t of adminToolDefinitions.filter((d) => !d.readOnly)) {
    out.push({ name: t.name, description: t.description + CONFIRM_NOTE, inputSchema: t.input_schema, readOnly: false });
  }
  out.push(
    {
      name: SEARCH,
      description:
        "Search the store for customers, products, invoices, vendors and purchases by name, nickname, invoice number or vendor invoice number (Vietnamese with or without accents). An empty query lists all customers. Returns results with an id; pass that id to fetch for the details.",
      inputSchema: { type: "object", properties: { query: { type: "string", description: "What to look for." } }, required: ["query"] },
      readOnly: true,
    },
    {
      name: FETCH,
      description: "Get the full details of one search result by its id: a customer with their current debt, a product, an invoice, a vendor or a purchase.",
      inputSchema: { type: "object", properties: { id: { type: "string", description: "An id returned by search." } }, required: ["id"] },
      readOnly: true,
    }
  );
  out.push({
    name: CONFIRM_ACTION,
    description:
      "Save something that was previewed by any tool that changes data (it returned needs_confirmation with a confirmToken). Call only after the person has seen the preview and said yes. Saves exactly what was previewed. Each token works once and expires after 30 minutes; calling again with the same token returns the same result instead of saving it twice.",
    inputSchema: {
      type: "object",
      properties: { confirmToken: { type: "string", description: "The confirmToken from the preview." } },
      required: ["confirmToken"],
    },
    readOnly: false,
  });
  return out;
}

export const externalTools: ExternalTool[] = buildCatalog();
const externalToolNames = new Set(externalTools.map((t) => t.name));

/** Instructions for an outside AI connecting over MCP (sent once at connection time). */
export const EXTERNAL_INSTRUCTIONS = [
  "This is the invoice app of a small Vietnamese wholesale/grocery store. Customer, product and vendor names are often Vietnamese, typed without accents or as nicknames; search tools match them fuzzily.",
  "All amounts are USD. The app computes every total, balance, debt and stock count — always report the numbers it returns, never your own arithmetic.",
  "You can do everything the app can: invoices (drafts, finished invoices, edits, voids), delivery orders and setting their final prices, customer payments (one invoice, or a customer's whole payment oldest invoice first), fixing or cancelling a payment, debt adjustments, customers, products, vendors, purchases from vendors (Buy from vendor: adds stock), vendor payments, cancelling a purchase, Custom Invoice print info, the payment request statement, the invoice list and dashboard numbers.",
  "Search before you act. If a tool returns needs_confirmation with candidates, ask the person which one they mean. needs_new_product → offer createProduct; needs_new_customer → offer createCustomer; needs_new_vendor → offer createVendor.",
  "Every tool that changes data takes two steps: it returns a preview and a confirmToken; show the preview, and call confirmAction only after the person says yes. Never say something was saved until confirmAction returns a saved status (created, updated, recorded, converted, cancelled, saved, finalized, alias_added).",
  "Nothing can be permanently deleted. Voiding an invoice or cancelling a purchase keeps it, marked void/cancelled. Payments can't be more than what is still owed.",
].join("\n");

/** Runs one outside-AI tool call as `user`. Unknown names are refused; business errors come back as results. */
export async function runExternalTool(name: string, args: Record<string, unknown>, user: AuthedUser): Promise<unknown> {
  if (!externalToolNames.has(name)) return { status: "error", message: `Unknown tool "${name}".` };
  if (name === CONFIRM_ACTION) return confirmAction(String(args.confirmToken ?? ""), user);
  if (name === SEARCH) return searchAll(String(args.query ?? ""));
  if (name === FETCH) return fetchOne(String(args.id ?? ""));
  if (CONFIRM_TOOLS.includes(name)) {
    const result = (await runTool(name, args, { previewOnly: true })) as Record<string, unknown>;
    if (result.status !== "preview") return result; // needs_confirmation / needs_new_customer / needs_more_info / error…
    const token = randomBytes(24).toString("base64url");
    const now = Date.now();
    // JSON round-trip drops undefined fields (Firestore rejects them).
    const pinnedArgs = JSON.parse(JSON.stringify(result.pinnedArgs));
    const db = getAdminDb();
    const ref = db.collection(PENDING_COLLECTION).doc(tokenId(token));
    await db.runTransaction(async (tx) => {
      tx.create(ref, { tool: name, args: pinnedArgs, uid: user.uid, storeId: user.storeId, createdAt: now, expiresAt: now + PENDING_TTL_MS });
    });
    return {
      status: "needs_confirmation",
      message: "Nothing saved yet. Show this preview to the person; if they say yes, call confirmAction with confirmToken.",
      preview: result.preview,
      confirmToken: token,
      expiresInMinutes: PENDING_TTL_MS / 60_000,
    };
  }
  return runTool(name, args, {});
}

/** One door to both tool sets: the shared chat tools (tools.ts) and the outside-only admin tools (adminTools.ts). */
function runTool(name: string, args: Record<string, unknown>, ctx: { previewOnly?: boolean; operationId?: string; canConfirm?: boolean }): Promise<unknown> {
  if (adminToolNames.has(name)) return runAdminTool(name, args, { previewOnly: ctx.previewOnly, operationId: ctx.operationId });
  return executeTool(name, args, { channel: "api", ...ctx });
}

/* ------------------------- search / fetch (ChatGPT's shape) ------------------------- */

type SearchHit = { id: string; title: string; url: string };
type Row = Record<string, unknown> & { id: string };

/** A link back to the app, so ChatGPT can cite it. Relative when this deployment doesn't know its own address. */
const appLink = (path: string) => `${workerBaseUrl() ?? ""}${path}`;

/** Results come straight from the shared search tools; ids are prefixed with the kind so fetch knows where to look. */
async function searchAll(query: string): Promise<{ results: SearchHit[] }> {
  const q = query.trim();
  if (!q || q === "*") {
    const customers = (await getAllCustomers()).filter((c) => c.active !== false);
    return { results: customers.map((c) => ({ id: `customer:${c.id}`, title: `Customer: ${c.name}`, url: appLink("/customers") })) };
  }
  const run = async (tool: string, args: Record<string, unknown>) =>
    (((await executeTool(tool, args, { channel: "api" })) as { results?: Row[] }).results ?? []);
  const [customers, products, invoices, vendors, purchases] = await Promise.all([
    run("searchCustomer", { query: q }),
    run("searchProduct", { query: q }),
    run("searchInvoices", { text: q, limit: 10 }),
    runAdminTool("searchVendor", { query: q }).then((r) => ((r as { results?: Row[] }).results ?? []).filter((v) => Number(v.score) >= 0.55)),
    runAdminTool("searchPurchases", { query: q, limit: 10 }).then((r) => (r as { purchases?: Row[] }).purchases ?? []),
  ]);
  return {
    results: [
      ...customers.map((c) => ({ id: `customer:${c.id}`, title: `Customer: ${c.name}`, url: appLink("/customers") })),
      ...products.map((p) => ({ id: `product:${p.id}`, title: `Product: ${p.name}`, url: appLink("/products") })),
      ...invoices.map((i) => ({ id: `invoice:${i.id}`, title: `Invoice #${i.invoiceNumber} – ${i.customerName}`, url: appLink(`/invoices/${i.id}`) })),
      ...vendors.map((v) => ({ id: `vendor:${v.id}`, title: `Vendor: ${v.name}`, url: appLink(`/vendors/${v.id}`) })),
      ...purchases.map((p) => ({ id: `purchase:${p.id}`, title: `Purchase ${p.purchaseNumber} – ${p.vendorName}${p.vendorInvoiceNumber ? ` (#${p.vendorInvoiceNumber})` : ""}`, url: appLink(`/purchases/${p.id}`) })),
    ],
  };
}

async function fetchOne(id: string): Promise<unknown> {
  const [kind, ...rest] = id.split(":");
  const key = rest.join(":");
  if (!key) return { status: "error", message: "Unknown id. Use an id returned by search." };
  const read = (tool: string, args: Record<string, unknown>) => executeTool(tool, args, { channel: "api" }) as Promise<Record<string, unknown>>;
  let title: string;
  let url: string;
  let data: Record<string, unknown>;
  if (kind === "customer") {
    const found = await read("getCustomer", { customerId: key });
    if (!found.customer) return { status: "not_found" };
    // Debt numbers come from the app, like everywhere else.
    data = { ...found, debt: await read("getCustomerDebt", { customerId: key }) };
    title = `Customer: ${(found.customer as { name: string }).name}`;
    url = appLink("/customers");
  } else if (kind === "product") {
    data = await read("getProduct", { productId: key });
    if (!data.product) return { status: "not_found" };
    title = `Product: ${(data.product as { name: string }).name}`;
    url = appLink("/products");
  } else if (kind === "invoice") {
    data = await read("getInvoice", { invoiceId: key });
    if (!data.invoice) return { status: "not_found" };
    const inv = data.invoice as { invoiceNumber: string; customerName: string };
    title = `Invoice #${inv.invoiceNumber} – ${inv.customerName}`;
    url = appLink(`/invoices/${key}`);
  } else if (kind === "vendor") {
    if (!(await getVendor(key))) return { status: "not_found" };
    data = (await runAdminTool("getVendor", { vendorId: key })) as Record<string, unknown>;
    title = `Vendor: ${(data.vendor as { name: string }).name}`;
    url = appLink(`/vendors/${key}`);
  } else if (kind === "purchase") {
    const purchase = await getPurchase(key);
    if (!purchase) return { status: "not_found" };
    data = (await runAdminTool("getPurchase", { purchaseId: key })) as Record<string, unknown>;
    title = `Purchase ${purchase.purchaseNumber} – ${purchase.vendorName}`;
    url = appLink(`/purchases/${key}`);
  } else {
    return { status: "error", message: "Unknown id. Use an id returned by search." };
  }
  return { id, title, text: JSON.stringify(data), url, metadata: { kind } };
}

/** Tokens are stored by hash, so reading the database never reveals a usable token. */
function tokenId(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function confirmAction(token: string, user: AuthedUser): Promise<unknown> {
  if (!token) return { status: "error", message: "confirmToken is required." };
  const id = tokenId(token);
  const snap = await getAdminDb().collection(PENDING_COLLECTION).doc(id).get();
  const pending = snap.exists ? (snap.data() as { tool: string; args: Record<string, unknown>; uid: string; storeId: string; expiresAt: number }) : null;
  // A token from another person's key is treated as unknown, so it reveals nothing.
  if (!pending || pending.uid !== user.uid || pending.storeId !== user.storeId) {
    return { status: "not_found", message: "Unknown confirmToken. Preview it again to get a new one." };
  }
  if (Date.now() > pending.expiresAt) {
    return { status: "expired", message: "This preview expired. Preview it again and ask the person to confirm." };
  }
  // The operation id is fixed per token: the store's idempotency ledger makes a second confirm (a retry, a double
  // tap) return the invoice saved the first time instead of creating a second one.
  // canConfirm: the person said yes to this exact preview (it is what lets a previewed force=true product save).
  return runTool(pending.tool, pending.args, { operationId: `api_${id.slice(0, 40)}`, canConfirm: true });
}
