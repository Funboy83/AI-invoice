import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getAdminDb } from "./firebaseAdmin";
import { HttpError, currentStoreId, type AuthedUser } from "./auth";
import { memberByEmail } from "./membership";
import { executeTool, toolDefinitions } from "@/lib/ai/tools";

/**
 * The door for OUTSIDE AI apps (Claude, ChatGPT, or a script) — used by the REST API (/api/v1/tools) and the MCP
 * server (/api/mcp). It is a thin layer over the SAME tools the in-app chat and Telegram use (src/lib/ai/tools.ts):
 * one set of business rules, one database, one audit log. Nothing here does its own money math.
 *
 * Off unless AI_API_ENABLED=true. Who may use it: AI_API_KEYS = "appLoginEmail:secretKey, …" — each key belongs to an
 * existing app member (storeMembers), checked live on every call, so removing the member also cuts off the key.
 *
 * What it can do (narrow on purpose — docs/OPERATING_POLICY.md rule 5, "new surfaces start narrow"):
 *   - read: search/get customers, products, invoices, debt, unpaid list, deliveries, payments, last price;
 *   - create an invoice draft or a delivery order, in two steps: the create call only PREVIEWS (nothing is saved)
 *     and returns a one-time confirm token; `confirmAction` with that token saves exactly what was previewed.
 * Not exposed: payments, editing or voiding invoices, converting deliveries (price changes), creating or changing
 * customers/products. Those stay in the app until each gets its own approval step.
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

/** Create tools that go through preview → confirmAction. */
const CONFIRM_TOOLS = ["createInvoiceDraft", "createDeliveryOrder"] as const;

export const CONFIRM_ACTION = "confirmAction";
const PENDING_COLLECTION = "apiPendingActions";
const PENDING_TTL_MS = 30 * 60 * 1000;

export interface ExternalTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

const CONFIRM_NOTE =
  " OUTSIDE-APP RULE: this call only PREVIEWS — nothing is saved. It returns status needs_confirmation with the preview and a confirmToken. Show the preview to the person (customer, items, quantities, prices, totals and any warnings) and call confirmAction with the token only after they say yes. If they want changes, call this tool again with the corrected order to get a new preview.";

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
  for (const name of CONFIRM_TOOLS) {
    const t = byName.get(name)!;
    // The chat-only `confirmed` flag means nothing here: confirming is done with confirmAction's token.
    const schema = stripProperty(t.input_schema as Record<string, unknown>, "confirmed");
    const description = t.description.replace(/ If the result is needs_confirmation with a preview[^]*$/, "") + CONFIRM_NOTE;
    out.push({ name, description, inputSchema: schema, readOnly: false });
  }
  out.push({
    name: CONFIRM_ACTION,
    description:
      "Save an invoice draft or delivery order that was previewed by createInvoiceDraft or createDeliveryOrder. Call only after the person has seen the preview and said yes. Saves exactly what was previewed (same customer, products, quantities and prices). Each token works once and expires after 30 minutes; calling again with the same token returns the same saved invoice instead of saving it twice.",
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
  "This is the invoice app of a small Vietnamese wholesale/grocery store. Customer and product names are often Vietnamese, typed without accents or as nicknames; search tools match them fuzzily.",
  "All amounts are USD. The app computes every total, balance and debt — always report the numbers it returns, never your own arithmetic.",
  "Search before you act. If a tool returns needs_confirmation with candidates, ask the person which one they mean. If it returns needs_new_customer or needs_new_product, tell them to add it in the app first (this connection cannot create customers or products).",
  "Creating an invoice draft or a delivery order takes two steps: the create tool returns a preview and a confirmToken; show the preview, and call confirmAction only after the person says yes. Never say something was saved until confirmAction returns status created.",
  "This connection cannot record payments, edit or void invoices, or set final prices on deliveries — those are done in the app.",
].join("\n");

/** Runs one outside-AI tool call as `user`. Unknown names are refused; business errors come back as results. */
export async function runExternalTool(name: string, args: Record<string, unknown>, user: AuthedUser): Promise<unknown> {
  if (!externalToolNames.has(name)) return { status: "error", message: `Unknown tool "${name}".` };
  if (name === CONFIRM_ACTION) return confirmAction(String(args.confirmToken ?? ""), user);
  if ((CONFIRM_TOOLS as readonly string[]).includes(name)) {
    const result = (await executeTool(name, args, { channel: "api", previewOnly: true })) as Record<string, unknown>;
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
  return executeTool(name, args, { channel: "api" });
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
    return { status: "not_found", message: "Unknown confirmToken. Preview the order again to get a new one." };
  }
  if (Date.now() > pending.expiresAt) {
    return { status: "expired", message: "This preview expired. Preview the order again and ask the person to confirm." };
  }
  // The operation id is fixed per token: the store's idempotency ledger makes a second confirm (a retry, a double
  // tap) return the invoice saved the first time instead of creating a second one.
  return executeTool(pending.tool, pending.args, { channel: "api", operationId: `api_${id.slice(0, 40)}` });
}
