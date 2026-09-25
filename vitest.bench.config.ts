import { defineConfig } from "vitest/config";
import path from "node:path";

/** Opt-in live measurements (`npm run bench:orders`). Never part of `npm test`: they call the real model API. */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { environment: "node", include: ["src/test/bench/*.live.ts"], testTimeout: 600_000, hookTimeout: 60_000 },
});
