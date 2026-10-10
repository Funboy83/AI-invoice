import { store } from "../fakeFirestore";
import { executeTool } from "@/lib/ai/tools";
import type { ShopFixture } from "../seedShop";

export type DraftMode = "names+prices" | "names, no prices" | "ids+prices";

export interface DraftMeasurement {
  items: number;
  mode: DraftMode;
  status: string;
  ops: number;
  docs: number;
  byCollection: Record<string, number>;
  docsByCollection: Record<string, number>;
  ms: number;
  result: Record<string, unknown>;
}

/** Runs one createInvoiceDraft for `n` distinct products and reports Firestore reads (ops = round trips, docs = documents). */
export async function measureDraft(shop: ShopFixture, n: number, mode: DraftMode, operationId: string): Promise<DraftMeasurement> {
  const items = Array.from({ length: n }, (_, i) => {
    const price = mode === "names, no prices" ? undefined : 20 + (i % 5);
    return mode === "ids+prices"
      ? { productId: shop.productIds[i * 3], quantity: 2 + (i % 4), price }
      : { productName: shop.productNames[i * 3], quantity: 2 + (i % 4), ...(price === undefined ? {} : { price }) };
  });
  store.resetMetrics();
  const t0 = performance.now();
  const result = (await executeTool("createInvoiceDraft", { customerName: "Hoa Lee", items }, { operationId })) as Record<string, unknown>;
  const ms = performance.now() - t0;
  const m = store.metrics;
  return { items: n, mode, status: String(result.status), ops: m.ops, docs: m.docs, byCollection: { ...m.byCollection }, docsByCollection: { ...m.docsByCollection }, ms, result };
}
