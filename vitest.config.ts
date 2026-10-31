import { configDefaults, defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    // The logs viewer is a separate package with its own tests and config.
    exclude: [...configDefaults.exclude, "request-logger/viewer/**"],
  },
});
