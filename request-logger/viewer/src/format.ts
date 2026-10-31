import type { CSSProperties } from "react";
import type { Usage } from "../shared/types";

export const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** All times: HH:MM:SS AM/PM, e.g. 08:34:12 PM. */
export const fmtTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });

export const fmtDate = (iso: string): string =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true });

export const fmtGap = (ms: number): string =>
  ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;

export const totalPrompt = (u: Usage) => u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens;

export const cacheHitRatio = (u: Usage): number => {
  const t = totalPrompt(u);
  return t ? u.cacheReadTokens / t : 0;
};

export const shortId = (id: string) => id.slice(0, 8);

/** Stable colour per subagent number (1-based). Avoids the chart's token colours where possible. */
const AGENT_PALETTE = ["#14b8a6", "#ec4899", "#a78bfa", "#facc15", "#38bdf8", "#a3e635", "#fb7185", "#818cf8", "#2dd4bf", "#f0abfc"];
export const agentColor = (index: number | null | undefined): string =>
  index ? AGENT_PALETTE[(index - 1) % AGENT_PALETTE.length] : "#14b8a6";

/** Inline style that sets --agent for CSS to tint badges, borders and strips. */
export const agentStyle = (index: number | null | undefined) =>
  index ? ({ "--agent": agentColor(index) } as CSSProperties) : undefined;
