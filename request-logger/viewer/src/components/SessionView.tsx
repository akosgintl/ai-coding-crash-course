import { useMemo, useState } from "react";
import type { CallSummary, SessionDetail } from "../../shared/types";
import { agentStyle, cacheHitRatio, fmtDate, fmtGap, fmtTime, fmtTokens, shortId } from "../format";
import { AgentLanes } from "./AgentLanes";
import { ContextChart } from "./ContextChart";
import { KindBadge } from "./KindBadge";
import { UsageBar, UsageLegend, UsageStats } from "./UsageBar";

export function SessionView(props: {
  session: SessionDetail;
  selectedCall: string | null;
  onSelectCall: (id: string) => void;
  freshIds: string[];
}) {
  const s = props.session;
  const [showSub, setShowSub] = useState(true);
  const [showMainSide, setShowMainSide] = useState(true);
  const [showSubSide, setShowSubSide] = useState(true);
  const [showSession, setShowSession] = useState(true);

  const allCalls = useMemo(
    () => [...s.preamble, ...s.turns.flatMap((t) => [...t.calls, ...t.nested])].sort((a, b) => a.id.localeCompare(b.id)),
    [s],
  );
  const counts = useMemo(() => {
    const c = { main: 0, mainSide: 0, sub: 0, subSide: 0, session: 0 };
    for (const x of allCalls) {
      if (x.owner === "session") c.session++;
      else if (x.owner === "main") x.kind === "side" ? c.mainSide++ : c.main++;
      else x.kind === "side" ? c.subSide++ : c.sub++;
    }
    return c;
  }, [allCalls]);
  const maxCtx = Math.max(1, ...allCalls.map((c) => c.contextTokens + (c.usage?.outputTokens ?? 0)));

  // Subagent numbers hidden by the per-agent filter chips.
  const [hiddenAgents, setHiddenAgents] = useState<Set<number>>(new Set());
  const toggleAgent = (i: number) =>
    setHiddenAgents((h) => {
      const n = new Set(h);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });

  // owner × kind: subagent chips hide everything a subagent owns, side toggles split by owner.
  const visible = (c: CallSummary) => {
    if (c.owner === "session") return showSession;
    if (c.owner === "main") return c.kind !== "side" || showMainSide;
    if (hiddenAgents.has(c.agentIndex ?? 0)) return false;
    return c.kind === "side" ? showSubSide : showSub;
  };

  return (
    <div className="session">
      <section className="session-head">
        <h1>{s.title}</h1>
        <div className="muted">
          {fmtDate(s.startedAt)} → {fmtTime(s.endedAt)} · <span className="mono">{s.sessionId}</span> · {s.models.join(", ")}
        </div>
        <div className="cards">
          <div className="card">
            <div className="card-value">{s.turnCount}</div>
            <div className="card-label">turns (your prompts)</div>
          </div>
          <div className="card">
            <div className="card-value">{s.callCount}</div>
            <div className="card-label">
              API calls: {counts.main} main + {counts.mainSide} side · {counts.sub} subagent + {counts.subSide} side · {counts.session} session
            </div>
          </div>
          <div className="card">
            <div className="card-value">{fmtTokens(s.peakContextTokens)}</div>
            <div className="card-label">peak context window</div>
          </div>
          <div className="card">
            <div className="card-value">{Math.round(cacheHitRatio(s.usage) * 100)}%</div>
            <div className="card-label">of prompt tokens served from cache</div>
          </div>
        </div>
        <UsageStats usage={s.usage} />
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Context window per call</h2>
          <UsageLegend />
        </div>
        <ContextChart calls={allCalls} selected={props.selectedCall} onSelect={props.onSelectCall} />
      </section>

      {s.agents.length > 0 && (
        <AgentLanes agents={s.agents} selectedCall={props.selectedCall} onSelectCall={props.onSelectCall} freshIds={props.freshIds} />
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>Turns</h2>
          <div className="toggles">
            <label><input type="checkbox" checked={showMainSide} onChange={(e) => setShowMainSide(e.target.checked)} /> main side ({counts.mainSide})</label>
            <label><input type="checkbox" checked={showSub} onChange={(e) => setShowSub(e.target.checked)} /> subagent ({counts.sub})</label>
            <label><input type="checkbox" checked={showSubSide} onChange={(e) => setShowSubSide(e.target.checked)} /> subagent side ({counts.subSide})</label>
            <label><input type="checkbox" checked={showSession} onChange={(e) => setShowSession(e.target.checked)} /> session ({counts.session})</label>
            {s.agents.map((a) => (
              <button
                key={a.index}
                className={`agent-chip ${hiddenAgents.has(a.index) ? "off" : ""}`}
                style={agentStyle(a.index)}
                disabled={!showSub && !showSubSide}
                onClick={() => toggleAgent(a.index)}
                title={`${hiddenAgents.has(a.index) ? "Show" : "Hide"} subagent ${a.index}: ${a.description}`}
              >
                <span className="dot" />
                <span>{a.index} · {a.description}</span>
              </button>
            ))}
          </div>
        </div>

        {s.preamble.length > 0 && (
          <TurnBlock title="Before the first prompt" calls={s.preamble.filter(visible)} {...props} maxCtx={maxCtx} />
        )}
        {s.turns.map((t) => {
          const calls = [...t.calls, ...t.nested.filter(visible)].sort((a, b) => a.id.localeCompare(b.id));
          const peak = Math.max(0, ...t.calls.map((c) => c.contextTokens));
          return (
            <TurnBlock
              key={t.index}
              title={`Turn ${t.index}`}
              prompt={t.prompt}
              meta={`${t.calls.length} main call${t.calls.length === 1 ? "" : "s"} · ${t.nested.length} nested · out ${fmtTokens(t.usage.outputTokens)} · context peak ${fmtTokens(peak)}`}
              calls={calls}
              maxCtx={maxCtx}
              {...props}
            />
          );
        })}
      </section>
    </div>
  );
}

function TurnBlock(props: {
  title: string;
  prompt?: string;
  meta?: string;
  calls: CallSummary[];
  maxCtx: number;
  selectedCall: string | null;
  onSelectCall: (id: string) => void;
  freshIds: string[];
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="turn">
      <div className="turn-head" onClick={() => setOpen(!open)}>
        <span className="chev">{open ? "▾" : "▸"}</span>
        <span className="turn-title">{props.title}</span>
        {props.prompt && <span className="turn-prompt">{props.prompt.replace(/\s+/g, " ").slice(0, 160)}</span>}
        {props.meta && <span className="muted turn-meta">{props.meta}</span>}
      </div>
      {open && (
        <div className="calls">
          {props.calls.map((c, i) => (
            <CallRow
              key={c.id}
              call={c}
              prev={props.calls[i - 1]}
              maxCtx={props.maxCtx}
              selected={c.id === props.selectedCall}
              fresh={props.freshIds.includes(c.id)}
              onClick={() => props.onSelectCall(c.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CallRow(props: { call: CallSummary; prev?: CallSummary; maxCtx: number; selected: boolean; fresh: boolean; onClick: () => void }) {
  const c = props.call;
  const gap = props.prev ? Date.parse(c.timestamp) - Date.parse(props.prev.timestamp) : null;
  return (
    <div
      className={`call-row kind-${c.kind} owner-${c.owner} ${props.selected ? "selected" : ""} ${props.fresh ? "fresh" : ""}`}
      style={agentStyle(c.agentIndex)}
      onClick={props.onClick}
    >
      <span className="call-time mono" title={c.timestamp}>
        {fmtTime(c.timestamp)}
        {gap !== null && <span className="gap">+{fmtGap(gap)}</span>}
      </span>
      <KindBadge call={c} title={c.owner === "subagent" ? `thread ${shortId(c.threadId.split(":")[1] ?? "")}` : undefined} />
      <span className="call-label" title={c.label}>{c.label}</span>
      <span className="call-tools">
        {c.toolsUsed.map((t, i) => (
          <span key={i} className="tool-chip">{t}</span>
        ))}
        {c.error && <span className="tool-chip err" title={c.error}>error</span>}
      </span>
      <span className="call-ctx mono" title="context window = uncached + cache write + cache read">
        {c.usage ? fmtTokens(c.contextTokens) : "—"}
      </span>
      <span className="call-out mono" title="output tokens">{c.usage ? `↑${fmtTokens(c.usage.outputTokens)}` : ""}</span>
      <span className="call-bar"><UsageBar usage={c.usage} max={props.maxCtx} /></span>
      <span className="call-stop muted">{c.stopReason ?? ""}</span>
    </div>
  );
}
