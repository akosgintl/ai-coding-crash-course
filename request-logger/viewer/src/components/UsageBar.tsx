import type { Usage } from "../../shared/types";
import { fmtTokens } from "../format";

export const USAGE_PARTS = [
  { key: "cacheReadTokens", label: "cache read", cls: "c-read" },
  { key: "cacheCreationTokens", label: "cache write", cls: "c-write" },
  { key: "inputTokens", label: "uncached input", cls: "c-input" },
  { key: "outputTokens", label: "output", cls: "c-output" },
] as const;

/** Horizontal stacked bar of a usage record, scaled to `max`. */
export function UsageBar({ usage, max, height = 8 }: { usage: Usage | null; max: number; height?: number }) {
  if (!usage) return <div className="usage-bar empty" style={{ height }} />;
  return (
    <div className="usage-bar" style={{ height }} title={USAGE_PARTS.map((p) => `${p.label}: ${usage[p.key].toLocaleString()}`).join("\n")}>
      {USAGE_PARTS.map((p) => (
        <div key={p.key} className={p.cls} style={{ width: `${(usage[p.key] / Math.max(max, 1)) * 100}%` }} />
      ))}
    </div>
  );
}

export function UsageLegend() {
  return (
    <div className="legend">
      {USAGE_PARTS.map((p) => (
        <span key={p.key}>
          <i className={p.cls} /> {p.label}
        </span>
      ))}
    </div>
  );
}

export function UsageStats({ usage }: { usage: Usage }) {
  return (
    <div className="stats">
      {USAGE_PARTS.map((p) => (
        <div key={p.key} className="stat">
          <div className={`stat-swatch ${p.cls}`} />
          <div className="stat-value">{fmtTokens(usage[p.key])}</div>
          <div className="stat-label">{p.label}</div>
        </div>
      ))}
      <div className="stat">
        <div className="stat-swatch c-think" />
        <div className="stat-value">{fmtTokens(usage.thinkingTokens)}</div>
        <div className="stat-label">of which thinking</div>
      </div>
    </div>
  );
}
