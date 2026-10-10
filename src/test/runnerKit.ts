import type Anthropic from "@anthropic-ai/sdk";
import type { Firestore } from "firebase-admin/firestore";
import { store, adminFacade } from "./fakeFirestore";
import { __setAdminDbForTests } from "@/lib/server/firebaseAdmin";
import type { AuthedUser } from "@/lib/server/auth";
import { acceptMessage, timeSource, type JobDoc } from "@/lib/server/chatJobs";
import { INVOCATION_LIMIT_MS, type RunnerDeps } from "@/lib/server/agentRunner";
import { executeTool as realExecuteTool } from "@/lib/ai/tools";
import type { ChatMessageDoc } from "@/lib/chat/types";

/** Shared helpers for the job-runner tests: a scripted model, a controllable clock, and shop fixtures. */

export const wife: AuthedUser = { uid: "wife", email: "wife@example.com", storeId: "main" };
export const CID = "main__wife";

let clock = 1_000_000;
export const advance = (ms: number) => (clock += ms);
let reqCounter = 0;

/** Grants (or, called again with a different storeId/omitted, effectively revokes for "main") store membership for a uid. */
export function seedMembership(uid: string, storeId = "main") {
  store.put(`storeMembers/${uid}`, { uid, email: `${uid}@example.com`, storeId, addedAt: 1, addedByEmail: "admin@example.com" });
}
export function revokeMembership(uid: string) {
  store.docs.delete(`storeMembers/${uid}`);
}

/** Call from beforeEach: fresh store, fresh clock, engine pointed at the in-memory Firestore, `wife` a member. */
export function resetRunnerEnv() {
  store.reset();
  clock = 1_000_000;
  timeSource.now = () => clock;
  __setAdminDbForTests(adminFacade() as unknown as Firestore);
  seedMembership(wife.uid);
}

/* ------------------------------ scripted model ------------------------------ */

export type Block = Record<string, unknown>;
export const text = (t: string): Block => ({ type: "text", text: t });
export const toolUse = (id: string, name: string, input: Record<string, unknown>): Block => ({ type: "tool_use", id, name, input });
export type Step = Block[] | ((messages: Anthropic.Messages.MessageParam[]) => Block[]);

/** Returns the parsed result of the most recent tool_result in a conversation (so scripts can chain on real ids). */
export function lastToolResult(messages: Anthropic.Messages.MessageParam[]): Record<string, unknown> {
  const last = messages[messages.length - 1];
  const block = (last.content as unknown as Block[]).find((b) => b.type === "tool_result") as { content: string };
  return JSON.parse(block.content);
}

/** All tool_result blocks of the last user message, parsed, in the order the model will see them. */
export function toolResultsInOrder(messages: Anthropic.Messages.MessageParam[]): { id: string; result: Record<string, unknown> }[] {
  const last = messages[messages.length - 1];
  return (last.content as unknown as Block[])
    .filter((b) => b.type === "tool_result")
    .map((b) => ({ id: String(b.tool_use_id), result: JSON.parse(String(b.content)) }));
}

export function scriptedModel(steps: Step[], usage: Record<string, number> = { input_tokens: 1200, output_tokens: 60, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 }) {
  const calls: Anthropic.Messages.MessageParam[][] = [];
  const timeouts: number[] = [];
  const createMessage: RunnerDeps["createMessage"] = async (params, opts) => {
    calls.push(structuredClone(params.messages) as Anthropic.Messages.MessageParam[]);
    timeouts.push(opts?.timeoutMs);
    const step = steps[calls.length - 1];
    if (!step) throw new Error(`model called more often than scripted (${calls.length})`);
    const content = typeof step === "function" ? step(params.messages) : step;
    return { content, usage, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" } as unknown as Anthropic.Messages.Message;
  };
  return { createMessage, calls, timeouts };
}

export const deps = (model: { createMessage: RunnerDeps["createMessage"] }, over: Partial<RunnerDeps> = {}): RunnerDeps => ({
  createMessage: model.createMessage,
  executeTool: realExecuteTool,
  sleep: async () => {},
  budgetMs: INVOCATION_LIMIT_MS,
  continueJob: async () => true,
  ...over,
});

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
export async function waitFor(cond: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

/* --------------------------------- fixtures --------------------------------- */

export function seedCatalog() {
  store.put("customers/c1", { name: "Hoa Lee", aliases: [], active: true, defaultShipping: 0, createdAt: 1_000, updatedAt: 1_000 });
  store.put("products/p1", { name: "Milo", aliases: [], defaultUnit: "thùng", defaultPrice: 29, active: true, createdAt: 1_000, updatedAt: 1_000 });
  store.put("products/p2", { name: "Bột giặt", aliases: [], defaultUnit: "bao", defaultPrice: 10, active: true, createdAt: 1_000, updatedAt: 1_000 });
  store.put("products/p3", { name: "Kem đánh răng", aliases: [], defaultUnit: "hộp", defaultPrice: 5, active: true, createdAt: 1_000, updatedAt: 1_000 });
}

export const jobId = (seq: number) => `${CID}__j${String(seq).padStart(6, "0")}`;
export const jobDoc = (seq: number) => store.read(`chatJobs/${jobId(seq)}`) as unknown as JobDoc;
const msg = (order: number) => store.read(`chatConversations/${CID}/messages/${String(order).padStart(8, "0")}`) as unknown as ChatMessageDoc | undefined;
export const replyMsg = (seq: number) => msg(seq * 2 + 1);
export const userMsg = (seq: number) => msg(seq * 2) as ChatMessageDoc;
export const say = (content: string) => acceptMessage(wife, { requestId: `req-${++reqCounter}-xxxxxxxx`, content });

export const createDraft = (id = "toolu_1") => toolUse(id, "createInvoiceDraft", { customerName: "Hoa Lee", items: [{ productName: "Milo", quantity: 10, price: 29 }] });

export { realExecuteTool };
