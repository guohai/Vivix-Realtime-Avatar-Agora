// vitest.config.mjs
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["server/**/*.test.mjs", "web/src/**/*.test.ts"], environment: "node" },
});
