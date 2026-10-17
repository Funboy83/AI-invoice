import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Firestore } from "firebase-admin/firestore";

vi.mock("firebase/firestore", async () => (await import("@/test/fakeFirestore")).clientModule);
vi.mock("@/lib/firebase", () => ({ db: {}, firebaseApp: {} }));

import { store, adminFacade } from "@/test/fakeFirestore";
import { __setAdminDbForTests } from "@/lib/server/firebaseAdmin";
import { POST as mcpPost, GET as mcpGet } from "@/app/api/mcp/route";
import { POST as mcpPathPost } from "@/app/api/mcp/[key]/route";
import { GET as listTools } from "@/app/api/v1/tools/route";
import { POST as callTool } from "@/app/api/v1/tools/[name]/route";

const KEY = "k".repeat(40);

function rpc(body: unknown, headers: Record<string, string> = { authorization: `Bearer ${KEY}` }, path = "/api/mcp") {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  store.reset();
  __setAdminDbForTests(adminFacade() as unknown as Firestore);
  vi.stubEnv("AI_API_ENABLED", "true");
  vi.stubEnv("AI_API_KEYS", `wife@example.com:${KEY}`);
  store.put("storeMembers/wife", { uid: "wife", email: "wife@example.com", storeId: "main", addedAt: 1, addedByEmail: "a@x.com" });
  store.put("customers/c1", { name: "Hoa Lee", aliases: [], active: true, defaultShipping: 0, createdAt: 1, updatedAt: 1 });
  store.put("products/p1", { name: "Milo", aliases: [], defaultUnit: "thùng", defaultPrice: 29, active: true, createdAt: 1, updatedAt: 1 });
});
afterEach(() => vi.unstubAllEnvs());

describe("MCP server", () => {
  it("is invisible (404) when turned off", async () => {
    vi.stubEnv("AI_API_ENABLED", "");
    expect((await mcpPost(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }))).status).toBe(404);
  });

  it("says what is wrong (503) when switched on but AI_API_KEYS is mistyped, without revealing anything", async () => {
    vi.stubEnv("AI_API_KEYS", KEY); // key without the email
    const res = await mcpPost(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.message).toMatch(/AI_API_KEYS/);
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it("rejects a request without the right key (401)", async () => {
    const res = await mcpPost(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });

  it("initializes, lists tools and calls one — key in the header", async () => {
    const init = await (await mcpPost(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }))).json();
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.capabilities.tools).toBeDefined();
    expect(init.result.instructions).toContain("USD");

    const note = await mcpPost(rpc({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(note.status).toBe(202);

    const list = await (await mcpPost(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }))).json();
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("getCustomerDebt");
    expect(names).toEqual(expect.arrayContaining(["recordPayment", "createPurchase", "createVendor"]));
    expect(names).not.toContain("requestUserInput");
    expect(list.result.tools.find((t: { name: string }) => t.name === "searchCustomer").annotations.readOnlyHint).toBe(true);

    const call = await (await mcpPost(rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "searchCustomer", arguments: { query: "hoa" } } }))).json();
    expect(call.result.isError).toBe(false);
    expect(JSON.parse(call.result.content[0].text).results[0].name).toBe("Hoa Lee");
  });

  it("works with the key in the link, for apps that only take a URL", async () => {
    const res = await mcpPathPost(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {}, `/api/mcp/${KEY}`), { params: Promise.resolve({ key: KEY }) });
    expect(res.status).toBe(200);
    const bad = await mcpPathPost(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {}, "/api/mcp/nope"), { params: Promise.resolve({ key: "nope" }) });
    expect(bad.status).toBe(401);
  });

  it("refuses unknown tools and methods", async () => {
    const call = await (await mcpPost(rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "deleteInvoice", arguments: { invoiceId: "x" } } }))).json();
    expect(call.error.code).toBe(-32602);
    const m = await (await mcpPost(rpc({ jsonrpc: "2.0", id: 5, method: "resources/list" }))).json();
    expect(m.error.code).toBe(-32601);
    expect(store.count("payments")).toBe(0);
  });

  it("does not offer the server-push GET stream", () => {
    expect(mcpGet().status).toBe(405);
  });
});

describe("REST API", () => {
  it("lists tools and runs the preview → confirm flow", async () => {
    const auth = { "x-api-key": KEY };
    const list = await (await listTools(new Request("http://localhost/api/v1/tools", { headers: auth }))).json();
    expect(list.tools.map((t: { name: string }) => t.name)).toContain("confirmAction");

    const call = (name: string, body: unknown) =>
      callTool(new Request(`http://localhost/api/v1/tools/${name}`, { method: "POST", headers: auth, body: JSON.stringify(body) }), { params: Promise.resolve({ name }) });
    const preview = await (await call("createDeliveryOrder", { customerName: "Hoa Lee", items: [{ productName: "milo", quantity: 2 }] })).json();
    expect(preview.result.status).toBe("needs_confirmation");
    expect(store.count("invoices")).toBe(0);
    const saved = await (await call("confirmAction", { confirmToken: preview.result.confirmToken })).json();
    expect(saved.result.status).toBe("created");
    expect(store.count("invoices")).toBe(1);

    expect((await call("deleteInvoice", {})).status).toBe(404);
  });

  it("rejects calls without a key", async () => {
    expect((await listTools(new Request("http://localhost/api/v1/tools"))).status).toBe(401);
  });
});
