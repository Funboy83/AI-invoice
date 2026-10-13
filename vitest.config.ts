import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  // *.emulator.test.ts (src/test/emulator/) needs a running Firestore emulator — run separately via
  // `npm run test:emulator` (vitest.emulator.config.ts), never as part of the default `npm test`.
  test: { environment: "node", setupFiles: ["src/test/setupStore.ts"], include: ["src/**/*.test.ts"], exclude: ["**/node_modules/**", "**/*.emulator.test.ts"] },
});
