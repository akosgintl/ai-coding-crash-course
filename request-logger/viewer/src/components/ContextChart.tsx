import { useState } from "react";
import type { CallSummary } from "../../shared/types";
import { agentColor, fmtTime, fmtTokens } from "../format";
import { KindBadge, ownerColor } from "./KindBadge";

/** One stacked column per call: cache read / cache write / uncached input / output. */
export function ContextChart(props: { calls: CallSummary[]; selected: string | null; onSelect: (id: string) => void }) {
  const [hover, setHover] = useState<CallSummary | null>(null);
  const calls = props.calls;
  const H = 180;
  const max = Math.max(1, ...calls.map((c) => c.contextTokens + (c.usage?.outputTokens ?? 0)));
  const colW = Math.max(4, Math.min(22, 1100 / Math.max(calls.length, 1)));
  const W = calls.length * colW;
  const y = (n: number) => (n / max) * H;
  const ticks = niceTicks(max);

  return (
    <div className="chart-wrap">
      <div className="chart-scroll">
        <svg width={W + 50} height={H + 26} className="chart">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={44} x2={W + 50} y1={H - y(t)} y2={H - y(t)} className="grid" />
              <text x={40} y={H - y(t) + 4} textAnchor="end" className="axis">{fmtTokens(t)}</text>
            </g>
          ))}
          {calls.map((c, i) => {
            const u = c.usage;
            const x = 48 + i * colW;
            const w = colW - 2;
            const parts = u
              ? [
                  { v: u.cacheReadTokens, cls: "c-read" },
                  { v: u.cacheCreationTokens, cls: "c-write" },
                  { v: u.inputTokens, cls: "c-input" },
                  { v: u.outputTokens, cls: "c-output" },
                ]
              : [];
            let acc = 0;
            return (
              <g
                key={c.id}
                className={`col kind-${c.kind} ${c.id === props.selected ? "selected" : ""}`}
                onMouseEnter={() => setHover(c)}
                onMouseLeave={() => setHover(null)}
                onClick={() => props.onSelect(c.id)}
              >
                <rect x={x - 1} y={0} width={colW} height={H} className="hit" />
                {parts.map((p, j) => {
                  const h = y(p.v);
                  acc += h;
                  return <rect key={j} x={x} y={H - acc} width={w} height={h} className={p.cls} />;
                })}
                {!u && <rect x={x} y={H - 3} width={w} height={3} className="c-error" />}
                <rect x={x} y={H + 4} width={w} height={4} className={`kind-strip ${c.kind === "side" ? "is-side" : ""}`} style={{ fill: ownerColor(c, agentColor) }} />
              </g>
            );
          })}
          {calls.map((c, i) => {
            if (!c.rewind) return null;
            // Line before the first call after the rewind: history to the left was partly undone.
            const x = 48 + i * colW - 1;
            return (
              <g key={`rewind-${c.id}`} className="rewind-marker">
                <line x1={x} x2={x} y1={0} y2={H + 10} />
                <text x={x + 4} y={22}>↶ rewind</text>
                <title>{`rewind at ${fmtTime(c.timestamp)} — kept ${c.rewind.keptMessages} messages, dropped ${c.rewind.droppedMessages}`}</title>
              </g>
            );
          })}
          {calls.map((c, i) => {
            if (!c.compaction) return null;
            // Line after the summary call: everything to the right runs on the compacted history.
            const x = 48 + (i + 1) * colW - 1;
            return (
              <g key={`compact-${c.id}`} className="compact-marker">
                <line x1={x} x2={x} y1={0} y2={H + 10} />
                <text x={x + 4} y={10}>/compact</text>
                <title>{`/compact at ${fmtTime(c.timestamp)} — context ${fmtTokens(c.contextTokens)} summarised into ${fmtTokens(c.usage?.outputTokens ?? 0)} output tokens`}</title>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="chart-hover">
        {hover ? (
          <>
            <KindBadge call={hover} /> <span className="mono">{fmtTime(hover.timestamp)}</span>{" "}
            <b>{hover.label}</b>
            {hover.usage ? (
              <span className="muted">
                {" "}· context {fmtTokens(hover.contextTokens)} (read {fmtTokens(hover.usage.cacheReadTokens)}, write{" "}
                {fmtTokens(hover.usage.cacheCreationTokens)}, fresh {fmtTokens(hover.usage.inputTokens)}) · out {fmtTokens(hover.usage.outputTokens)}
              </span>
            ) : (
              <span className="muted"> · {hover.error ?? "no usage"}</span>
            )}
          </>
        ) : (
          <span className="muted">Hover a column for details, click to inspect. The strip under each column is its owner: main, a subagent (own colour) or session; faded = side call.</span>
        )}
      </div>
    </div>
  );
}

function niceTicks(max: number): number[] {
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const s = max / step > 5 ? step * 2 : max / step > 2 ? step : step / 2;
  const out: number[] = [];
  for (let t = 0; t <= max; t += s) out.push(t);
  return out;
}
