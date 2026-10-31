import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so tests don't start the logs watcher.
export default defineConfig({
  test: { include: ["server/**/*.test.ts", "src/**/*.test.ts"] },
});
