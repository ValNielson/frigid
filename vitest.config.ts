import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node by default, so the pure-module tests can use node:assert. The
    // convex-test files opt into edge-runtime with a per-file pragma, because
    // that is the environment Convex functions actually run in.
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
