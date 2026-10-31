import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logsApi } from "./server/plugin";

const here = path.dirname(fileURLToPath(import.meta.url));
const logsDir = path.resolve(process.env.LOGS_DIR ?? path.join(here, "..", "logs"));

export default defineConfig({
  root: here,
  plugins: [react(), logsApi(logsDir)],
  server: {
    host: "127.0.0.1", // logs contain account/device ids — keep it local
    port: 5180,
    strictPort: true,
    watch: { ignored: ["**/logs/**"] },
  },
});
