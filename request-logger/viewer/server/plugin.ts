// Vite plugin: serves the JSON API and a live SSE stream from the dev server itself,
// so the viewer is one process (`npm run dev`) with no extra backend.

import type { Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { LogStore } from "./store";
import { buildCallDetail, buildSession, sessionSummary } from "./parse";

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export function logsApi(logsDir: string): Plugin {
  const store = new LogStore(logsDir);

  return {
    name: "request-logger-viewer-api",
    configureServer(server) {
      store.watch();

      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const url = new URL(req.url ?? "/", "http://x");
        const p = url.pathname;
        if (!p.startsWith("/api/")) return next();

        if (p === "/api/sessions") {
          const list = [...store.bySession().values()]
            .map((calls) => sessionSummary(buildSession(calls)))
            .sort((a, b) => b.endedAt.localeCompare(a.endedAt));
          return json(res, 200, { logsDir, sessions: list });
        }

        let m = /^\/api\/sessions\/([^/]+)$/.exec(p);
        if (m) {
          const calls = store.bySession().get(decodeURIComponent(m[1]));
          return calls ? json(res, 200, buildSession(calls)) : json(res, 404, { error: "no such session" });
        }

        m = /^\/api\/sessions\/([^/]+)\/calls\/([^/]+)$/.exec(p);
        if (m) {
          const calls = store.bySession().get(decodeURIComponent(m[1]));
          const detail = calls && buildCallDetail(calls, decodeURIComponent(m[2]));
          return detail ? json(res, 200, detail) : json(res, 404, { error: "no such call" });
        }

        if (p === "/api/events") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          res.write(": connected\n\n");
          const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
          const off = store.onChange((ids) => {
            const sessions = [...new Set(store.all().filter((c) => ids.includes(c.id)).map((c) => c.sessionId))];
            res.write(`data: ${JSON.stringify({ ids, sessions })}\n\n`);
          });
          req.on("close", () => {
            clearInterval(ping);
            off();
          });
          return;
        }

        json(res, 404, { error: "unknown endpoint" });
      });
    },
  };
}
