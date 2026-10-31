// Reads capture files from the logs folder, caches parsed results, and watches for new ones.

import fs from "node:fs";
import path from "node:path";
import { parseCapture, type ParsedCall } from "./parse";

export class LogStore {
  private cache = new Map<string, { mtimeMs: number; call: ParsedCall }>();
  private listeners = new Set<(ids: string[]) => void>();
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(readonly dir: string) {}

  /** All complete captures (request + response both present), parsed. */
  all(): ParsedCall[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const set = new Set(names);
    const bases = names
      .filter((n) => n.endsWith(".request.txt"))
      .map((n) => n.slice(0, -".request.txt".length))
      .filter((b) => set.has(`${b}.response.txt`));

    const out: ParsedCall[] = [];
    for (const base of bases) {
      const call = this.load(base);
      if (call) out.push(call);
    }
    // drop cache entries for deleted files
    for (const k of this.cache.keys()) if (!set.has(`${k}.request.txt`)) this.cache.delete(k);
    return out;
  }

  private load(base: string): ParsedCall | null {
    const req = path.join(this.dir, `${base}.request.txt`);
    const res = path.join(this.dir, `${base}.response.txt`);
    try {
      const mtimeMs = Math.max(fs.statSync(req).mtimeMs, fs.statSync(res).mtimeMs);
      const hit = this.cache.get(base);
      if (hit && hit.mtimeMs === mtimeMs) return hit.call;
      const call = parseCapture(base, fs.readFileSync(req, "utf8"), fs.readFileSync(res, "utf8"));
      this.cache.set(base, { mtimeMs, call });
      return call;
    } catch {
      return null;
    }
  }

  bySession(): Map<string, ParsedCall[]> {
    const m = new Map<string, ParsedCall[]>();
    for (const c of this.all()) {
      const list = m.get(c.sessionId) ?? [];
      list.push(c);
      m.set(c.sessionId, list);
    }
    return m;
  }

  /** Notify listeners (debounced) when capture files appear or change. */
  watch(): void {
    fs.watch(this.dir, (_event, file) => {
      if (!file || !file.endsWith(".response.txt")) return;
      this.pending.add(file.slice(0, -".response.txt".length));
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        const ids = [...this.pending];
        this.pending.clear();
        for (const l of this.listeners) l(ids);
      }, 300);
    });
  }

  onChange(fn: (ids: string[]) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
