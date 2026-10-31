import { useState } from "react";
import type { Block, CallDetail, Message } from "../../shared/types";
import { api, useData } from "../api";
import { fmtTime, fmtTokens } from "../format";
import { KindBadge } from "./KindBadge";
import { UsageStats } from "./UsageBar";

const TABS = ["What's new", "Response", "System prompt", "Tools", "Params", "Full history"] as const;
type Tab = (typeof TABS)[number];

export function CallInspector(props: { sessionId: string; callId: string; onClose: () => void }) {
  const { data: c, error } = useData(() => api.call(props.sessionId, props.callId), [props.sessionId, props.callId]);
  const [tab, setTab] = useState<Tab>("What's new");

  return (
    <aside className="inspector">
      <div className="inspector-head">
        <button className="close" onClick={props.onClose} title="close">✕</button>
        {error && <div className="error">{error}</div>}
        {c && (
          <>
            <div>
              <KindBadge call={c} /> <span className="mono muted">{fmtTime(c.timestamp)} · {c.model}</span>
            </div>
            <h3>{c.label}</h3>
            <div className="muted small mono">{c.id}</div>
            {c.error && <div className="error">{c.error}</div>}
            {c.usage && <UsageStats usage={c.usage} />}
            <Breakdown c={c} />
          </>
        )}
      </div>
      {c && (
        <>
          <div className="tabs">
            {TABS.map((t) => (
              <button key={t} className={t === tab ? "active" : ""} onClick={() => setTab(t)}>
                {t}
                {t === "What's new" && <span className="count">{c.newMessages.length}</span>}
                {t === "Tools" && <span className="count">{c.tools.length}</span>}
                {t === "Full history" && <span className="count">{c.allMessages.length}</span>}
              </button>
            ))}
          </div>
          <div className="inspector-body">
            {tab === "What's new" && (
              <>
                <p className="hint">
                  {c.newFromIndex === 0
                    ? "First call in this thread — everything below is new."
                    : `Messages 1–${c.newFromIndex} were already sent in the previous call of this thread (incl. the model's own last reply). This is what the harness appended since — tool results, injected reminders, your prompt.`}
                </p>
                {c.newMessages.map((m, i) => (
                  <MessageView key={i} m={m} index={c.newFromIndex + i + 1} />
                ))}
              </>
            )}
            {tab === "Response" && (
              <>
                <p className="hint">stop reason: <b>{c.stopReason ?? "—"}</b></p>
                {c.response.length === 0 && <p className="muted">No content (error or empty response).</p>}
                {c.response.map((b, i) => (
                  <BlockView key={i} b={b} />
                ))}
              </>
            )}
            {tab === "System prompt" &&
              c.system.map((s, i) => (
                <div key={i} className="sys-block">
                  <div className="sys-head">
                    block {i + 1} · {s.text.length.toLocaleString()} chars
                    {s.cacheControl && <span className="tool-chip cache">cache breakpoint: {s.cacheControl}</span>}
                  </div>
                  <pre>{s.text}</pre>
                </div>
              ))}
            {tab === "Tools" && (
              <>
                <p className="hint">Tools offered to the model in this call (schema size in chars). Deferred tools are only listed by name until loaded via ToolSearch.</p>
                {[...c.tools].sort((a, b) => b.chars - a.chars).map((t) => (
                  <details key={t.name} className="tool">
                    <summary>
                      <b>{t.name}</b> <span className="muted">{t.chars.toLocaleString()} chars</span>
                    </summary>
                    <pre>{t.description}</pre>
                  </details>
                ))}
              </>
            )}
            {tab === "Params" && <pre>{JSON.stringify(c.params, null, 2)}</pre>}
            {tab === "Full history" && c.allMessages.map((m, i) => <MessageView key={i} m={m} index={i + 1} dim={i < c.newFromIndex} />)}
          </div>
        </>
      )}
    </aside>
  );
}

/** Estimated split of the context window by request section, proportional to characters. */
function Breakdown({ c }: { c: CallDetail }) {
  const parts = [
    { label: "system prompt", v: c.chars.system, cls: "b-sys" },
    { label: "tool schemas", v: c.chars.tools, cls: "b-tools" },
    { label: "history", v: c.chars.history, cls: "b-hist" },
    { label: "new this call", v: c.chars.newContent, cls: "b-new" },
  ];
  const total = parts.reduce((n, p) => n + p.v, 0) || 1;
  const tokens = c.contextTokens;
  return (
    <div className="breakdown">
      <div className="breakdown-title">Context composition {tokens ? `(≈ of ${fmtTokens(tokens)} tokens, estimated by char share)` : "(chars)"}</div>
      <div className="usage-bar" style={{ height: 10 }}>
        {parts.map((p) => (
          <div key={p.label} className={p.cls} style={{ width: `${(p.v / total) * 100}%` }} />
        ))}
      </div>
      <div className="legend">
        {parts.map((p) => (
          <span key={p.label}>
            <i className={p.cls} /> {p.label} {tokens ? `~${fmtTokens(Math.round((p.v / total) * tokens))}` : `${p.v} ch`}
          </span>
        ))}
      </div>
    </div>
  );
}

function MessageView({ m, index, dim }: { m: Message; index: number; dim?: boolean }) {
  return (
    <div className={`msg role-${m.role} ${dim ? "dim" : ""}`}>
      <div className="msg-head">
        #{index} <b>{m.role}</b>
      </div>
      {m.blocks.map((b, i) => (
        <BlockView key={i} b={b} />
      ))}
    </div>
  );
}

function BlockView({ b }: { b: Block }) {
  switch (b.type) {
    case "text":
      return (
        <div className={`blk ${b.injected ? "injected" : "text"}`}>
          {b.injected && <div className="blk-tag">injected by harness</div>}
          <Collapsible text={b.text} />
        </div>
      );
    case "thinking":
      return (
        <div className="blk thinking">
          <div className="blk-tag">thinking</div>
          <Collapsible text={b.text || "(empty — thinking display omitted/summarised)"} />
        </div>
      );
    case "tool_use":
      return (
        <div className="blk tool-use">
          <div className="blk-tag">tool call → {b.name} <span className="muted mono">{b.id}</span></div>
          <Collapsible text={typeof b.input === "string" ? b.input : JSON.stringify(b.input, null, 2)} />
        </div>
      );
    case "tool_result":
      return (
        <div className={`blk tool-result ${b.isError ? "err" : ""}`}>
          <div className="blk-tag">tool result {b.isError && "(error)"} <span className="muted mono">{b.toolUseId}</span></div>
          <Collapsible text={b.text} />
        </div>
      );
    default:
      return (
        <div className="blk other">
          <div className="blk-tag">{b.label}</div>
          <Collapsible text={b.raw} />
        </div>
      );
  }
}

function Collapsible({ text }: { text: string }) {
  const LIMIT = 1500;
  const [open, setOpen] = useState(text.length <= LIMIT);
  return (
    <>
      <pre>{open ? text : text.slice(0, LIMIT) + "…"}</pre>
      {text.length > LIMIT && (
        <button className="more" onClick={() => setOpen(!open)}>
          {open ? "show less" : `show all (${text.length.toLocaleString()} chars)`}
        </button>
      )}
    </>
  );
}
