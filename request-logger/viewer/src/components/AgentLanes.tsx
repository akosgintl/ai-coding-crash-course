import { useState, type ReactNode } from "react";
import type { AgentThread, CallSummary } from "../../shared/types";
import { agentStyle, cacheHitRatio, fmtGap, fmtTime, fmtTokens, totalPrompt } from "../format";
import { KindBadge } from "./KindBadge";
import { UsageBar } from "./UsageBar";

type Props = {
  agents: AgentThread[];
  selectedCall: string | null;
  onSelectCall: (id: string) => void;
  freshIds: string[];
};

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const baseTime = (id: string) =>
  id.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3}).*/, "$1T$2:$3:$4.$5Z");

/** Subagents on a shared timeline (who ran when, in parallel or not); click one for its full story. */
export function AgentLanes(props: Props) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setOpen((s) => {
      const n = new Set(s);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });

  const a = props.agents;
  // Time axis: from the first spawn to the last result handed back.
  const starts = a.flatMap((x) => [ms(x.spawnedAt), ms(x.startedAt)]).filter((n) => !isNaN(n));
 const ends = a.flatMap((x) => [ms(x.endedAt), ...x.sideCalls.map((c) => ms(c.timestamp)), ms(x.returnedIn ? baseTime(x.returnedIn) : null)]).filter((n) => !isNaN(n));
  const t0 = Math.min(...starts);
  const t1 = Math.max(t0 + 1000, ...ends);
  const pct = (t: number) => `${((t - t0) / (t1 - t0)) * 100}%`;
  const ticks = axisTicks(t1 - t0);

  const totalCalls = a.reduce((n, x) => n + x.calls.length, 0);
  const totalOut = a.reduce((n, x) => n + x.usage.outputTokens, 0);
  const overlapping = a.some((x, i) => a.some((y, j) => j !== i && ms(x.startedAt) < ms(y.endedAt) && ms(y.startedAt) < ms(x.endedAt)));

  return (
    <section className="panel agents">
      <div className="panel-head">
        <h2>Subagents</h2>
        <span className="muted">
          {a.length} agent{a.length === 1 ? "" : "s"} · {overlapping ? "ran in parallel" : "ran one after another"} · {totalCalls} calls ·
          out {fmtTokens(totalOut)} · {fmtTime(new Date(t0).toISOString())} → {fmtTime(new Date(t1).toISOString())} ({fmtGap(t1 - t0)})
        </span>
      </div>

      <div className="ag-grid">
        <div className="ag-axis-row">
          <div />
          <div className="ag-axis">
            {ticks.map((t) => (
              <span key={t} style={{ left: pct(t0 + t) }}>+{fmtGap(t)}</span>
            ))}
          </div>
          <div className="ag-stat-head muted">
            <span>calls</span><span>time</span><span>out</span><span>peak ctx</span>
          </div>
        </div>

        {a.map((x) => {
          const isOpen = open.has(x.index);
          const runMs = ms(x.endedAt) - ms(x.startedAt);
          return (
            <div key={x.threadId} className={`ag-row ${isOpen ? "open" : ""}`} style={agentStyle(x.index)}>
              <div className="ag-line" onClick={() => toggle(x.index)}>
                <div className="ag-name">
                  <span className="chev">{isOpen ? "▾" : "▸"}</span>
                  <span className="ag-num">{x.index}</span>
                  <div className="ag-name-text">
                    <div className="ag-desc" title={x.description}>{x.description}</div>
                    <div className="muted small ag-sub">
                      {x.subagentType ?? "subagent"} · {x.model.replace(/^claude-/, "")}
                      {x.background && <span className="pill">background</span>}
                      <span className={`pill status-${x.status ?? "running"}`}>{x.status ?? (x.result ? "no report yet" : "running")}</span>
                    </div>
                  </div>
                </div>
                <div className="ag-track">
                  {ticks.map((t) => <span key={t} className="ag-grid-line" style={{ left: pct(t0 + t) }} />)}
                  {x.spawnedAt && (
                    <span className="ag-spawn" style={{ left: pct(ms(x.spawnedAt)), width: `calc(${pct(ms(x.startedAt))} - ${pct(ms(x.spawnedAt))})` }} title={`spawned by main at ${fmtTime(x.spawnedAt)}`} />
                  )}
                  <span className="ag-span" style={{ left: pct(ms(x.startedAt)), width: `calc(${pct(ms(x.endedAt))} - ${pct(ms(x.startedAt))} + 3px)` }} />
                  {x.calls.map((c, i) => (
                    <span
                      key={c.id}
                      className={`ag-tick ${c.id === props.selectedCall ? "selected" : ""} ${c.error ? "err" : ""}`}
                      style={{ left: pct(ms(c.timestamp)) }}
                      title={`#${i + 1} ${fmtTime(c.timestamp)} · ${c.toolsUsed.join(", ") || c.stopReason || ""} · ctx ${fmtTokens(c.contextTokens)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onSelectCall(c.id);
                      }}
                    />
                  ))}
                  {x.sideCalls.map((c) => (
                    <span
                      key={c.id}
                      className={`ag-tick side ${c.id === props.selectedCall ? "selected" : ""}`}
                      style={{ left: pct(ms(c.timestamp)) }}
                      title={`side call ${fmtTime(c.timestamp)} · ${c.label}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onSelectCall(c.id);
                      }}
                    />
                  ))}
                  {x.returnedIn && (
                    <span className="ag-return" style={{ left: pct(ms(baseTime(x.returnedIn))) }} title={`result read by main at ${fmtTime(baseTime(x.returnedIn))}`}>◂</span>
                  )}
                </div>
                <div className="ag-stats mono">
                  <span>{x.calls.length}{x.sideCalls.length > 0 && <span className="muted small" title="side calls (progress summaries…)"> +{x.sideCalls.length}</span>}</span>
                  <span>{fmtGap(runMs)}</span>
                  <span>{fmtTokens(x.usage.outputTokens)}</span>
                  <span>{fmtTokens(x.peakContextTokens)}</span>
                </div>
              </div>
              {isOpen && <AgentDetail agent={x} {...props} />}
            </div>
          );
        })}
      </div>
      <div className="muted small ag-legend">
        <span className="ag-legend-spawn" /> waiting to start after spawn · <span className="ag-legend-span" /> running · ┃ API call · <span className="ag-legend-side" /> side call on its thread (progress summary…), click to inspect · ◂ result read by main thread
      </div>
    </section>
  );
}

function AgentDetail(props: Props & { agent: AgentThread }) {
  const x = props.agent;
  const toolCounts = new Map<string, number>();
  for (const c of x.calls) for (const t of c.toolsUsed) toolCounts.set(t, (toolCounts.get(t) ?? 0) + 1);
  const toolCalls = [...toolCounts.values()].reduce((a, b) => a + b, 0);
  const errors = x.calls.filter((c) => c.error).length;
  const maxCtx = Math.max(1, ...x.calls.map((c) => c.contextTokens + (c.usage?.outputTokens ?? 0)));
  // Work calls numbered 1..n; side calls interleaved by time, unnumbered.
  const order = new Map(x.calls.map((c, i) => [c.id, i + 1]));
  const steps = [...x.calls, ...x.sideCalls]
    .sort((p, q) => p.id.localeCompare(q.id))
    .map((c) => ({ c, n: order.get(c.id) ?? null }));

  return (
    <div className="ag-detail">
      <div className="ag-detail-cols">
        <div className="ag-texts">
          <Clamp title="Task given by the main agent" text={x.prompt || "(no prompt captured)"} />
          <Clamp
            title={x.returnedIn ? `Report the main agent received${x.background ? " (task notification)" : ""}` : "Last reply (not yet handed back to the main agent)"}
            text={x.result ?? "(no result captured yet)"}
          />
          <div className="muted small">
            {x.spawnedBy && (
              <>spawned by <Link id={x.spawnedBy} {...props}>main call {fmtTime(baseTime(x.spawnedBy))}</Link></>
            )}
            {x.returnedIn && (
              <> · result read in <Link id={x.returnedIn} {...props}>main call {fmtTime(baseTime(x.returnedIn))}</Link></>
            )}
            {x.toolUseId && <> · <span className="mono">{x.toolUseId}</span></>}
          </div>
        </div>
        <div className="ag-facts">
          <Fact v={x.calls.length} l={`API calls${x.sideCalls.length ? ` + ${x.sideCalls.length} side` : ""}`} />
          <Fact v={toolCalls} l="tool calls" />
          <Fact v={fmtGap(ms(x.endedAt) - ms(x.startedAt))} l="running time" />
          <Fact v={fmtTokens(x.peakContextTokens)} l="peak context" />
          <Fact v={fmtTokens(x.usage.outputTokens)} l="output tokens" />
          <Fact v={fmtTokens(totalPrompt(x.usage))} l="prompt tokens (all calls)" />
          <Fact v={`${Math.round(cacheHitRatio(x.usage) * 100)}%`} l="served from cache" />
          <Fact v={errors} l="errors" warn={errors > 0} />
          <div className="ag-tools">
            {[...toolCounts.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([t, n]) => (
                <span key={t} className="tool-chip ag-tool">{t} <b>×{n}</b></span>
              ))}
          </div>
        </div>
      </div>
      <div className="ag-steps">
        {steps.map(({ c, n }, i) => (
          <Step key={c.id} c={c} n={n} prev={steps[i - 1]?.c} maxCtx={maxCtx} {...props} />
        ))}
      </div>
    </div>
  );
}

function Step(props: Props & { c: CallSummary; n: number | null; prev?: CallSummary; maxCtx: number }) {
  const c = props.c;
  const gap = props.prev ? ms(c.timestamp) - ms(props.prev.timestamp) : null;
  return (
    <div
      className={`ag-step ${c.kind === "side" ? "side" : ""} ${c.id === props.selectedCall ? "selected" : ""} ${props.freshIds.includes(c.id) ? "fresh" : ""}`}
      onClick={() => props.onSelectCall(c.id)}
    >
      <span className="ag-step-n mono">{props.n ?? "·"}</span>
      <span className="mono muted">{fmtTime(c.timestamp)}{gap !== null && <span className="gap">+{fmtGap(gap)}</span>}</span>
      <span className="ag-step-what">
        {c.kind === "side" ? (
          <KindBadge call={c} />
        ) : c.toolsUsed.length ? (
          c.toolsUsed.map((t, j) => <span key={j} className="tool-chip">{t}</span>)
        ) : (
          <span className="tool-chip done">{c.stopReason === "end_turn" ? "final answer" : c.stopReason ?? "?"}</span>
        )}
        {c.error && <span className="tool-chip err" title={c.error}>error</span>}
        <span className="muted" title={c.label}> {c.label}</span>
      </span>
      <span className="mono call-ctx" title="context window">{c.usage ? fmtTokens(c.contextTokens) : "—"}</span>
      <span className="mono call-out" title="output tokens">{c.usage ? `↑${fmtTokens(c.usage.outputTokens)}` : ""}</span>
      <span className="call-bar"><UsageBar usage={c.usage} max={props.maxCtx} /></span>
    </div>
  );
}

function Clamp(props: { title: string; text: string }) {
  const [full, setFull] = useState(false);
  const long = props.text.length > 600 || props.text.split("\n").length > 8;
  return (
    <div className="ag-clamp">
      <div className="ag-clamp-title">
        {props.title} <span className="muted small">{fmtTokens(props.text.length)} chars</span>
        {long && <button className="link" onClick={() => setFull(!full)}>{full ? "collapse" : "show all"}</button>}
      </div>
      <pre className={full ? "" : "clamped"}>{props.text}</pre>
    </div>
  );
}

function Fact(props: { v: string | number; l: string; warn?: boolean }) {
  return (
    <div className={`ag-fact ${props.warn ? "warn" : ""}`}>
      <div className="ag-fact-v">{props.v}</div>
      <div className="muted small">{props.l}</div>
    </div>
  );
}

function Link(props: Props & { id: string; children: ReactNode }) {
  return (
    <a href="#" onClick={(e) => { e.preventDefault(); props.onSelectCall(props.id); }}>
      {props.children}
    </a>
  );
}

/** ~5 round time steps across the span. */
function axisTicks(span: number): number[] {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].map((s) => s * 1000);
  const step = steps.find((s) => span / s <= 6) ?? 3600_000;
  const out: number[] = [];
  for (let t = 0; t <= span; t += step) out.push(t);
  return out;
}
