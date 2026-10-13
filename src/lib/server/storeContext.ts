import { AsyncLocalStorage } from "node:async_hooks";
import { isStoreId } from "@/lib/stores";

/**
 * Which store the current server work is for. Every entry point (a business API route, the AI chat job, the
 * outside-AI API) wraps its work in runInStore(storeId, …) with the store it authenticated, and businessStore.ts
 * reads it back with activeStoreId() to pick the collections. If nothing set it, activeStoreId() THROWS instead of
 * guessing a default: a request that forgot to say its store must fail, never land in the wrong store's data.
 */
const als = new AsyncLocalStorage<string>();

export function runInStore<T>(storeId: string, fn: () => T): T {
  if (!isStoreId(storeId)) throw new Error(`Unknown store "${storeId}".`);
  return als.run(storeId, fn);
}

let testDefault: string | null = null;
/** Tests that don't care about stores run in this store. Never called in production code. */
export function __setDefaultStoreForTests(storeId: string | null) {
  testDefault = storeId;
}

export function activeStoreId(): string {
  const id = als.getStore() ?? testDefault;
  if (!id) throw new Error("No store selected for this request (internal error) — nothing was read or saved.");
  return id;
}
