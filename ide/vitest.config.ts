import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Tests cover the main process's pure logic — diff construction, the URL
 * policy, and the scripted agent. None of it touches Electron, which is what
 * keeps it testable in a plain Node environment.
 */
export default defineConfig({
  resolve: {
    alias: { "@shared": resolve(import.meta.dirname, "src/shared") },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
