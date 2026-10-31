import type { SessionSummary } from "../../shared/types";
import { fmtDate, fmtTokens, shortId } from "../format";

export function SessionList(props: {
  sessions: SessionSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
  liveSessions: string[];
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-title">Sessions ({props.sessions.length})</div>
      {props.sessions.map((s) => {
        const out = s.usage.outputTokens;
        return (
          <button
            key={s.sessionId}
            className={`session-item ${s.sessionId === props.selected ? "selected" : ""} ${props.liveSessions.includes(s.sessionId) ? "pulse" : ""}`}
            onClick={() => props.onSelect(s.sessionId)}
          >
            <div className="session-title">{s.title}</div>
            <div className="session-meta">
              <span>{fmtDate(s.startedAt)}</span>
              <span className="mono">{shortId(s.sessionId)}</span>
            </div>
            <div className="session-meta">
              <span>{s.turnCount} turns · {s.callCount} calls</span>
              <span title="peak context window / output tokens">
                ⛁ {fmtTokens(s.peakContextTokens)} · ↑{fmtTokens(out)}
              </span>
            </div>
          </button>
        );
      })}
    </aside>
  );
}
