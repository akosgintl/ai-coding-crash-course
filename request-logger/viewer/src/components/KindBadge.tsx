import type { CallSummary } from "../../shared/types";
import { agentStyle } from "../format";

/** Short text for owner × kind: main · main side · subagent N · sub N side · session. */
export function kindLabel(c: Pick<CallSummary, "kind" | "owner" | "agentIndex">): string {
  const who = c.owner === "subagent" ? (c.agentIndex ? `sub ${c.agentIndex}` : "sub") : c.owner;
  if (c.owner === "session") return "session";
  if (c.kind === "side") return `${who} · side`;
  return c.owner === "subagent" ? `subagent${c.agentIndex ? ` ${c.agentIndex}` : ""}` : "main";
}

/** Colour comes from the owner (main / subagent N / session); side calls are drawn hollow and dashed. */
export function KindBadge(props: { call: Pick<CallSummary, "kind" | "owner" | "agentIndex">; title?: string }) {
  const c = props.call;
  return (
    <span
      className={`badge owner-${c.owner} ${c.kind === "side" ? "is-side" : ""}`}
      style={c.owner === "subagent" ? agentStyle(c.agentIndex ?? 1) : undefined}
      title={props.title}
    >
      {kindLabel(c)}
    </span>
  );
}

/** Fill for the chart strip / timeline marks of a call. */
export function ownerColor(c: Pick<CallSummary, "owner" | "agentIndex">, agentColor: (i: number) => string): string {
  return c.owner === "main" ? "var(--main)" : c.owner === "subagent" ? agentColor(c.agentIndex ?? 1) : "var(--side)";
}
