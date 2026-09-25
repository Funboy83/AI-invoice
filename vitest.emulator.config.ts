import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Emulator-backed Firestore RULES tests (`npm run test:emulator`) — real Firestore rule evaluation, not a
 * simulation. Never part of `npm test`: requires Java + firebase-tools (both are only devDependencies/local
 * tools, never bundled or deployed) and is driven by `firebase emulators:exec`, which starts the emulator, runs
 * this config, and shuts it down — see package.json's "test:emulator" script and README.md for setup.
 */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { environment: "node", include: ["src/test/emulator/**/*.emulator.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
});
