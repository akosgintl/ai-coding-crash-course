// Pure parsing: raw capture files -> calls -> threads -> turns -> sessions.
// No fs access here so it can be unit-tested with literal strings.

import type {
  AgentThread,
  Block,
  CallDetail,
  CallKind,
  CallOwner,
  CallSummary,
  Message,
  SessionDetail,
  SessionSummary,
  Turn,
  Usage,
} from "../shared/types";

/** Everything we keep about one capture, before session-level analysis. */
export type ParsedCall = {
  id: string;
  timestamp: string;
  sessionId: string;
  model: string;
  params: Record<string, unknown>;
  system: { text: string; cacheControl: string | null }[];
  tools: { name: string; description: string; chars: number }[];
  toolsChars: number;
  messages: Message[];
  messagesJson: string[]; // per-message JSON, for char maths
  /** Loose per-message fingerprints; the harness re-serialises old messages, so exact JSON can't be compared. */
  messageKeys: string[][];
  /** Set when the last message is a known harness fork prompt. */
  forkLabel: string | null;
  response: Block[];
  usage: Usage | null;
  stopReason: string | null;
  error: string | null;
  firstMessageKey: string;
  systemKey: string;
  isTitleCall: boolean;
};

// ---------- small helpers ----------

export function hash(s: string): string {
  // FNV-1a 32-bit; good enough to group identical strings.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** "2026-10-31T16-31-06-570_claude-code" -> "2026-10-31T16:31:06.570Z" */
export function timestampFromBase(base: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})/.exec(base);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : base;
}

const INJECTED_RE = /^\s*<([a-z][a-z0-9_-]*)[\s>]/i;

function isInjectedText(text: string): boolean {
  return INJECTED_RE.test(text);
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) =>
        c?.type === "text" ? String(c.text ?? "") : `[${c?.type ?? "block"}]`,
      )
      .join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

function normaliseBlock(b: any): Block {
  switch (b?.type) {
    case "text":
      return { type: "text", text: String(b.text ?? ""), injected: isInjectedText(String(b.text ?? "")) };
    case "thinking":
      return { type: "thinking", text: String(b.thinking ?? "") };
    case "redacted_thinking":
      return { type: "thinking", text: "[redacted thinking]" };
    case "tool_use":
      return { type: "tool_use", id: String(b.id ?? ""), name: String(b.name ?? ""), input: b.input };
    case "tool_result":
      return {
        type: "tool_result",
        toolUseId: String(b.tool_use_id ?? ""),
        text: toolResultText(b.content),
        isError: Boolean(b.is_error),
      };
    default:
      return { type: "other", label: String(b?.type ?? "unknown"), raw: JSON.stringify(b) };
  }
}

function normaliseMessage(m: any): Message {
  const role = String(m?.role ?? "unknown");
  if (typeof m?.content === "string") {
    return { role, blocks: [{ type: "text", text: m.content, injected: isInjectedText(m.content) }] };
  }
  return { role, blocks: Array.isArray(m?.content) ? m.content.map(normaliseBlock) : [] };
}

function sessionIdOf(body: any): string {
  const raw = body?.metadata?.user_id;
  if (typeof raw === "string") {
    try {
      const sid = JSON.parse(raw)?.session_id;
      if (typeof sid === "string") return sid;
    } catch {
      // older Claude Code: "user_<hash>_account_<uuid>_session_<uuid>"
      const m = /session_([0-9a-f-]{36})/.exec(raw);
      if (m) return m[1];
    }
  }
  return "unknown";
}

// ---------- response ----------

type ParsedResponse = {
  blocks: Block[];
  usage: Usage | null;
  stopReason: string | null;
  error: string | null;
};

function mergeUsage(into: Partial<Usage>, u: any) {
  if (!u || typeof u !== "object") return;
  if (typeof u.input_tokens === "number") into.inputTokens = u.input_tokens;
  if (typeof u.cache_creation_input_tokens === "number") into.cacheCreationTokens = u.cache_creation_input_tokens;
  if (typeof u.cache_read_input_tokens === "number") into.cacheReadTokens = u.cache_read_input_tokens;
  if (typeof u.output_tokens === "number") into.outputTokens = u.output_tokens;
  const th = u.output_tokens_details?.thinking_tokens;
  if (typeof th === "number") into.thinkingTokens = th;
}

function finishUsage(u: Partial<Usage>, seen: boolean): Usage | null {
  if (!seen) return null;
  return {
    inputTokens: u.inputTokens ?? 0,
    cacheCreationTokens: u.cacheCreationTokens ?? 0,
    cacheReadTokens: u.cacheReadTokens ?? 0,
    outputTokens: u.outputTokens ?? 0,
    thinkingTokens: u.thinkingTokens ?? 0,
  };
}

export function parseResponse(text: string): ParsedResponse {
  const trimmed = text.trim();
  if (!trimmed) return { blocks: [], usage: null, stopReason: null, error: "empty response" };

  // Non-streaming JSON (a plain message, or an error body).
  if (trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed);
      if (j?.type === "error") {
        return { blocks: [], usage: null, stopReason: null, error: `${j.error?.type ?? "error"}: ${j.error?.message ?? ""}`.trim() };
      }
      const u: Partial<Usage> = {};
      mergeUsage(u, j.usage);
      return {
        blocks: Array.isArray(j.content) ? j.content.map(normaliseBlock) : [],
        usage: finishUsage(u, Boolean(j.usage)),
        stopReason: j.stop_reason ?? null,
        error: null,
      };
    } catch {
      // fall through to SSE parsing
    }
  }

  const raw: any[] = [];
  const partialJson: string[] = [];
  const u: Partial<Usage> = {};
  let sawUsage = false;
  let stopReason: string | null = null;
  let error: string | null = null;

  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let ev: any;
    try {
      ev = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    switch (ev?.type) {
      case "message_start":
        if (ev.message?.usage) {
          sawUsage = true;
          mergeUsage(u, ev.message.usage);
        }
        break;
      case "content_block_start":
        raw[ev.index] = { ...ev.content_block };
        partialJson[ev.index] = "";
        break;
      case "content_block_delta": {
        const b = raw[ev.index] ?? (raw[ev.index] = { type: "text", text: "" });
        const d = ev.delta ?? {};
        if (d.type === "text_delta") b.text = (b.text ?? "") + d.text;
        else if (d.type === "thinking_delta") b.thinking = (b.thinking ?? "") + d.thinking;
        else if (d.type === "input_json_delta") partialJson[ev.index] = (partialJson[ev.index] ?? "") + d.partial_json;
        break;
      }
      case "message_delta":
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage) {
          sawUsage = true;
          mergeUsage(u, ev.usage);
        }
        break;
      case "error":
        error = `${ev.error?.type ?? "error"}: ${ev.error?.message ?? ""}`.trim();
        break;
    }
  }

  const blocks = raw
    .map((b, i) => {
      if (!b) return null;
      if (b.type === "tool_use" || b.type === "server_tool_use") {
        const pj = partialJson[i];
        if (pj) {
          try {
            b.input = JSON.parse(pj);
          } catch {
            b.input = pj;
          }
        }
        b.type = "tool_use";
      }
      return normaliseBlock(b);
    })
    .filter((b): b is Block => b !== null);

  return { blocks, usage: finishUsage(u, sawUsage), stopReason, error };
}

// ---------- request ----------

/** Identity of a block: tool ids where present, else a hash of the text's tail. */
export function blockKey(b: Block): string {
  if (b.type === "tool_use") return `use:${b.id}`;
  if (b.type === "tool_result") return `result:${b.toolUseId}`;
  if (b.type === "text" || b.type === "thinking")
    return `${b.type}:${hash(b.text.replace(/\s+/g, " ").trim().slice(-200))}`;
  return `other:${b.label}`;
}

/** Per message: role + block keys. Loose on purpose; the harness re-serialises old messages. */
export function messageKey(m: Message): string[] {
  return [m.role, ...m.blocks.map(blockKey)];
}

/**
 * Prompts the harness itself sends on a fork of a thread (not typed by you).
 * Matched against the last text of the request.
 */
export const COMPACTION_LABEL = "compaction — /compact summary that replaces the history";

export const HARNESS_FORKS:{ re: RegExp; label: string }[] = [
  { re: /SUGGESTION MODE/, label: "prompt suggestion — guesses your next message" },
  { re: /Describe your most recent action in 3-5 words/i, label: "progress summary — status line for a running agent" },
  { re: /The user stepped away and is coming back\. Recap/i, label: "away recap — summary for when you return" },
  { re: /Your task is to create a detailed summary of the conversation so far/i, label: COMPACTION_LABEL },
];

function harnessFork(messages: Message[]): string | null {
  const last = messages[messages.length - 1];
  const text = last?.blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n") ?? "";
  return HARNESS_FORKS.find((f) => f.re.test(text))?.label ?? null;
}

export function parseCapture(id: string, requestText: string, responseText: string): ParsedCall {
  let body: any = null;
  try {
    body = JSON.parse(requestText);
  } catch {
    body = null;
  }
  const res = parseResponse(responseText);

  const system: ParsedCall["system"] = [];
  if (typeof body?.system === "string") system.push({ text: body.system, cacheControl: null });
  else if (Array.isArray(body?.system)) {
    for (const s of body.system) {
      const cc = s?.cache_control;
      system.push({
        text: String(s?.text ?? ""),
        cacheControl: cc ? [cc.type, cc.ttl].filter(Boolean).join(" ") : null,
      });
    }
  }

  const rawTools: any[] = Array.isArray(body?.tools) ? body.tools : [];
  const tools = rawTools.map((t) => ({
    name: String(t?.name ?? t?.type ?? "?"),
    description: String(t?.description ?? ""),
    chars: JSON.stringify(t).length,
  }));

  const rawMessages: any[] = Array.isArray(body?.messages) ? body.messages : [];
  // cache_control markers move between calls; ignore them so identical history compares equal.
  const messagesJson = rawMessages.map((m) =>
    JSON.stringify(m, (k, v) => (k === "cache_control" ? undefined : v)),
  );
  const messages = rawMessages.map(normaliseMessage);
  const messageKeys = messages.map(messageKey);

  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body ?? {})) {
    if (k !== "messages" && k !== "system" && k !== "tools") params[k] = v;
  }

  const titleSchema = body?.output_config?.format?.schema?.properties?.title;

  return {
    id,
    timestamp: timestampFromBase(id),
    sessionId: sessionIdOf(body),
    model: String(body?.model ?? "unknown"),
    params,
    system,
    tools,
    toolsChars: JSON.stringify(rawTools).length,
    messages,
    messagesJson,
    messageKeys,
    forkLabel: harnessFork(messages),
    response: res.blocks,
    usage: res.usage,
    stopReason: res.stopReason,
    error: body ? res.error : "request body is not JSON (compressed or unknown wire format)",
    // Whole first message, normalised (string vs block-array content compare equal).
    firstMessageKey: messages[0] ? hash(JSON.stringify(messages[0])) : "",
    // Skip the billing header: its cc_version suffix is a fingerprint of the first message, so it
    // changes when /compact rewrites history — the agent (and its system prompt) did not.
    systemKey: hash(
      system
        .filter((s) => !s.text.startsWith("x-anthropic-billing-header:"))
        .map((s) => s.text)
        .join("\n"),
    ),
    isTitleCall: Boolean(titleSchema),
  };
}

// ---------- session analysis ----------

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
});

export function addUsage(a: Usage, b: Usage | null): Usage {
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    thinkingTokens: a.thinkingTokens + b.thinkingTokens,
  };
}

export function contextTokens(u: Usage | null): number {
  return u ? u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens : 0;
}

type Analysed = {
  call: ParsedCall;
  kind: CallKind;
  owner: CallOwner;
  threadId: string;
  newFromIndex: number;
  startsTurn: boolean;
  prompt: string;
  label: string;
  rewind: { keptMessages: number; droppedMessages: number } | null;
};

const sameMessage = (a: string[] | undefined, b: string[] | undefined) =>
  !!a && !!b && a.length === b.length && a.every((k, i) => k === b[i]);

function excerpt(s: string, n = 90): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function titleFromResponse(c: ParsedCall): string | null {
  const text = c.response.find((b) => b.type === "text");
  if (!text || text.type !== "text") return null;
  try {
    const t = JSON.parse(text.text)?.title;
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
}

/** Split the calls of one session into threads, kinds, deltas and turn boundaries. */
export function analyseSession(callsIn: ParsedCall[]): Analysed[] {
  const calls = [...callsIn].sort((a, b) => a.id.localeCompare(b.id));
  const mainSystemKey = calls.find((c) => c.tools.length > 0)?.systemKey;
  const lastInThread = new Map<string, ParsedCall>();
  const lastRealInThread = new Map<string, ParsedCall>();
  const out: Analysed[] = [];
  const threadOf = (c: ParsedCall) =>
    c.tools.length === 0 ? `side:${c.id}` : `${c.systemKey}:${c.firstMessageKey}`;

  // A "branch" is a call whose last message the next call in the same thread does not carry
  // forward — e.g. Claude Code's prompt-suggestion forks. It's housekeeping, not part of the turn.
  const branches = new Set<string>();
  const byThread = new Map<string, ParsedCall[]>();
  for (const c of calls) {
    if (c.tools.length === 0) continue;
    const list = byThread.get(threadOf(c)) ?? [];
    list.push(c);
    byThread.set(threadOf(c), list);
  }
  for (const list of byThread.values()) {
    const real = list.filter((c) => !c.forkLabel);
    for (const c of list) if (c.forkLabel) branches.add(c.id);
    for (let i = 0; i < real.length - 1; i++) {
      const x = real[i];
      const n = x.messageKeys.length;
      const [role, ...blocks] = x.messageKeys[n - 1] ?? [];
      const lastBlock = blocks[blocks.length - 1];
      const carriedForward = real.slice(i + 1).some((y) => {
        const [yRole, ...yBlocks] = y.messageKeys[n - 1] ?? [];
        return yRole === role && (lastBlock === undefined || yBlocks.includes(lastBlock));
      });
      if (!carriedForward) branches.add(x.id);
    }
  }

  for (const c of calls) {
    const branch = branches.has(c.id);
    const side = c.tools.length === 0 || branch;
    const threadId = threadOf(c);
    const kind: CallKind = side ? "side" : c.systemKey === mainSystemKey ? "main" : "subagent";
    // Forks keep their thread's system prompt, so the owner survives being a side call.
    const owner: CallOwner = c.tools.length === 0 ? "session" : c.systemKey === mainSystemKey ? "main" : "subagent";

    const prev = c.tools.length === 0 ? undefined : lastInThread.get(threadId);
    // Compare against the last real call, including ones a rewind later undid (they're "branches"
    // but were real conversation) — only harness forks are excluded.
    const lastReal = c.tools.length === 0 ? undefined : lastRealInThread.get(threadId);
    let newFromIndex = 0;
    let rewind: Analysed["rewind"] = null;
    if (!side && lastReal && c.messages.length < lastReal.messages.length) {
      // The thread shrank but kept its first message: a rewind. What's new starts after the shared prefix.
      let kept = 0;
      while (kept < c.messages.length && sameMessage(c.messageKeys[kept], lastReal.messageKeys[kept])) kept++;
      newFromIndex = kept;
      rewind = { keptMessages: kept, droppedMessages: lastReal.messages.length - kept };
    } else if (prev && c.messages.length >= prev.messages.length) {
      newFromIndex = prev.messages.length;
      // Skip the previous reply the harness echoes back; it's the model's output, not new input.
      if (c.messages[newFromIndex]?.role === "assistant") newFromIndex++;
    }
    if (!side) lastInThread.set(threadId, c);
    if (c.tools.length > 0 && !c.forkLabel) lastRealInThread.set(threadId, c);

    const newMsgs = c.messages.slice(newFromIndex);
    const hasToolResult = newMsgs.some((m) => m.blocks.some((b) => b.type === "tool_result"));
    const userTextsOf = (ms: Message[]) =>
      ms
        .filter((m) => m.role === "user")
        .flatMap((m) => m.blocks)
        .filter((b): b is Extract<Block, { type: "text" }> => b.type === "text" && !b.injected);
    const userTexts = userTextsOf(newMsgs);
    let prompt = userTexts.length ? userTexts[userTexts.length - 1].text : "";
    // After a rewind the prompt being (re)run may sit inside the kept prefix.
    if (rewind && !prompt && !hasToolResult) {
      const all = userTextsOf(c.messages);
      prompt = all.length ? all[all.length - 1].text : "";
    }
    const startsTurn = kind === "main" && !hasToolResult && (prompt !== "" || !prev);

    let label: string;
    if (branch) {
      const lastText = c.messages[c.messages.length - 1]?.blocks.find((b) => b.type === "text");
      const t = lastText && lastText.type === "text" ? lastText.text : "";
      const rewoundAway = (byThread.get(threadId) ?? []).some(
        (y) => y.id > c.id && !y.forkLabel && y.messages.length < c.messages.length,
      );
      label =
        c.forkLabel ??
        (rewoundAway ? "rewound away — undone by a later rewind" : `abandoned branch${t ? `: ${excerpt(t, 60)}` : ""}`);
    } else if (rewind && startsTurn) {
      label = `↶ rewind (kept ${rewind.keptMessages} msgs): ${excerpt(prompt, 70)}`;
    } else if (side) {
      const lastMsg = c.messages[c.messages.length - 1]?.blocks.find((b) => b.type === "text");
      const lastText = lastMsg && lastMsg.type === "text" ? lastMsg.text : "";
      label = c.isTitleCall
        ? `session title${titleFromResponse(c) ? `: “${titleFromResponse(c)}”` : ""}`
        : c.system.length === 0 && lastText.trim() === "quota"
          ? "quota check — startup probe of your rate limits"
          : excerpt(c.system[c.system.length - 1]?.text || lastText || "side call", 70);
    } else if (startsTurn) {
      label = excerpt(prompt || "(no prompt text)");
    } else if (hasToolResult) {
      const names = prev?.response.filter((b) => b.type === "tool_use").map((b) => (b as any).name) ?? [];
      label = `tool results → ${names.length ? names.join(", ") : "?"}`;
    } else {
      label = excerpt(prompt || "continuation");
    }

    out.push({ call: c, kind, owner, threadId, newFromIndex, startsTurn, prompt, label, rewind });
  }
  return out;
}

type AgentInfo = Pick<AgentThread, "index" | "threadId" | "description" | "subagentType" | "spawnedBy" | "toolUseId" | "prompt">;

const AGENT_TOOLS = new Set(["Agent", "Task"]);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Number the subagent threads (by first call) and link each to the Agent/Task tool_use that spawned it:
 * the spawn's `prompt` reappears as the subagent's first user message.
 */
export function identifyAgents(analysed: Analysed[]): Map<string, AgentInfo> {
  const spawns: { callId: string; toolUseId: string; input: any; used: boolean }[] = [];
  for (const a of analysed) {
    if (a.kind !== "main") continue;
    for (const b of a.call.response) {
      if (b.type === "tool_use" && AGENT_TOOLS.has(b.name)) {
        spawns.push({ callId: a.call.id, toolUseId: b.id, input: b.input ?? {}, used: false });
      }
    }
  }

  const out = new Map<string, AgentInfo>();
  for (const a of analysed) {
    if (a.kind !== "subagent" || out.has(a.threadId)) continue;
    const firstText = norm(
      (a.call.messages[0]?.blocks ?? [])
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n"),
    );
    const promptOf = (s: (typeof spawns)[number]) => norm(String(s.input?.prompt ?? ""));
    // Exact prompt match first; else the earliest unused spawn made before this thread started.
    const spawn =
      spawns.find((s) => !s.used && promptOf(s) && firstText.includes(promptOf(s).slice(0, 400))) ??
      spawns.find((s) => !s.used && s.callId < a.call.id);
    if (spawn) spawn.used = true;
    const userText = firstText.replace(/<([a-z][\w-]*)[\s>][\s\S]*?<\/\1>/gi, "").trim();
    out.set(a.threadId, {
      index: out.size + 1,
      threadId: a.threadId,
      description: String(spawn?.input?.description ?? "") || excerpt(userText || "subagent", 60),
      subagentType: typeof spawn?.input?.subagent_type === "string" ? spawn.input.subagent_type : null,
      spawnedBy: spawn?.callId ?? null,
      toolUseId: spawn?.toolUseId ?? null,
      prompt: spawn ? String(spawn.input?.prompt ?? "") : userText,
    });
  }
  return out;
}

/** Body of `<agent-message from="id">`, minus the harness's hand-back preamble and its 2-space indent. */
export function agentReport(text: string, agentId: string): string | null {
  const open = `<agent-message from="${agentId}">`;
  const start = text.indexOf(open);
  if (start < 0) return null;
  const end = text.indexOf("</agent-message>", start);
  let body = text.slice(start + open.length, end < 0 ? undefined : end);
  const marker = /The report follows:\s*\n/.exec(body);
  if (marker) body = body.slice(marker.index + marker[0].length);
  return body
    .split("\n")
    .map((l) => (l.startsWith("  ") ? l.slice(2) : l))
    .join("\n")
    .trim();
}

function summarise(a: Analysed, agents?: Map<string, AgentInfo>): CallSummary {
  const c = a.call;
  const historyChars = c.messagesJson.slice(0, a.newFromIndex).reduce((n, s) => n + s.length, 0);
  const newChars = c.messagesJson.slice(a.newFromIndex).reduce((n, s) => n + s.length, 0);
  return {
    id: c.id,
    timestamp: c.timestamp,
    sessionId: c.sessionId,
    model: c.model,
    kind: a.kind,
    owner: a.owner,
    threadId: a.threadId,
    compaction: c.forkLabel === COMPACTION_LABEL,
    rewind: a.rewind,
    label: a.label,
    messageCount: c.messages.length,
    toolCount: c.tools.length,
    stopReason: c.stopReason,
    error: c.error,
    usage: c.usage,
    contextTokens: contextTokens(c.usage),
    chars: {
      system: c.system.reduce((n, s) => n + s.text.length, 0),
      tools: c.toolsChars,
      history: historyChars,
      newContent: newChars,
    },
    toolsUsed: c.response.filter((b) => b.type === "tool_use").map((b) => (b as any).name),
    agentIndex: a.owner === "subagent" ? (agents?.get(a.threadId)?.index ?? null) : null,
  };
}

export function buildSession(calls: ParsedCall[]): SessionDetail {
  const analysed = analyseSession(calls);
  const agentInfo = identifyAgents(analysed);
  const summaries = analysed.map((a) => summarise(a, agentInfo));

  const agents: AgentThread[] = [...agentInfo.values()].map((info) => {
    const own = summaries.filter((s) => s.kind === "subagent" && s.threadId === info.threadId);
    const sideCalls = summaries.filter((s) => s.kind === "side" && s.owner === "subagent" && s.threadId === info.threadId);
    const ownCalls = analysed.filter((a) => a.kind === "subagent" && a.threadId === info.threadId).map((a) => a.call);
    // The result as the main agent saw it. Foreground agents: the tool_result of the spawning tool_use.
    // Background agents: that tool_result is only a launch ack; the report arrives later as a
    // <task-notification> (carrying the same <tool-use-id>) injected into the main thread.
    let result: string | null = null;
    let returnedIn: string | null = null;
    let status: string | null = null;
    let background = false;
    let agentId: string | null = null;
    let gotReport = false; // a full report (foreground tool_result or <agent-message>), not just a pointer
    if (info.toolUseId) {
      const tag = `<tool-use-id>${info.toolUseId}</tool-use-id>`;
      for (const a of analysed) {
        if (a.kind !== "main") continue;
        for (const b of a.call.messages.flatMap((m) => m.blocks)) {
          // The full report of a background agent: <agent-message from="<agentId>"> … </agent-message>.
          if (agentId && b.type === "text" && b.text.includes(`<agent-message from="${agentId}">`)) {
            const report = agentReport(b.text, agentId);
            if (report !== null) {
              result = report;
              returnedIn = a.call.id;
              status ??= "completed";
              gotReport = true;
            }
            continue;
          }
          if (b.type === "tool_result" && b.toolUseId === info.toolUseId && !background && returnedIn === null) {
            if (/^Async agent launched/.test(b.text)) {
              background = true;
              agentId = /agentId:\s*([0-9a-z]+)/i.exec(b.text)?.[1] ?? null;
            } else {
              result = b.text;
              returnedIn = a.call.id;
              status = b.isError ? "error" : "completed";
              gotReport = true;
            }
          } else if (b.type === "text" && b.text.includes(tag)) {
            const note = b.text.slice(b.text.lastIndexOf("<task-notification>", b.text.indexOf(tag)));
            background = true;
            status = /<status>([\s\S]*?)<\/status>/.exec(note)?.[1].trim() ?? null;
            // Newer harnesses put only a pointer here ("report was delivered … as a message"); keep a real report.
            if (result === null) {
              result = /<result>([\s\S]*?)<\/result>/.exec(note)?.[1].trim() ?? null;
              returnedIn = a.call.id;
            }
          }
        }
        if (gotReport || (returnedIn && !agentId)) break;
      }
    }
    if (result === null) {
      const last = ownCalls[ownCalls.length - 1];
      const text = last?.response.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("\n");
      result = text || null;
    }
    return {
      ...info,
      result,
      returnedIn,
      status,
      background,
      spawnedAt: info.spawnedBy ? timestampFromBase(info.spawnedBy) : null,
      model: ownCalls[0]?.model ?? "unknown",
      calls: own,
      sideCalls,
      usage: own.reduce((u, s) => addUsage(u, s.usage), emptyUsage()),
      startedAt: own[0]?.timestamp ?? "",
      endedAt: own[own.length - 1]?.timestamp ?? "",
      peakContextTokens: Math.max(0, ...own.map((s) => s.contextTokens)),
    };
  });
  const turns: Turn[] = [];
  const preamble: CallSummary[] = [];

  analysed.forEach((a, i) => {
    const s = summaries[i];
    if (a.startsTurn) {
      turns.push({
        index: turns.length + 1,
        prompt: a.prompt,
        startedAt: s.timestamp,
        calls: [s],
        nested: [],
        usage: addUsage(emptyUsage(), s.usage),
      });
      return;
    }
    const cur = turns[turns.length - 1];
    if (!cur) {
      preamble.push(s);
      return;
    }
    if (a.kind === "main") cur.calls.push(s);
    else cur.nested.push(s);
    cur.usage = addUsage(cur.usage, s.usage);
  });

  const title =
    analysed.map((a) => (a.call.isTitleCall ? titleFromResponse(a.call) : null)).find(Boolean) ??
    excerpt(turns[0]?.prompt ?? "(no prompt)", 70);

  return {
    sessionId: calls[0]?.sessionId ?? "unknown",
    title,
    startedAt: summaries[0]?.timestamp ?? "",
    endedAt: summaries[summaries.length - 1]?.timestamp ?? "",
    callCount: summaries.length,
    turnCount: turns.length,
    models: [...new Set(summaries.map((s) => s.model))],
    usage: summaries.reduce((u, s) => addUsage(u, s.usage), emptyUsage()),
    peakContextTokens: Math.max(0, ...summaries.map((s) => s.contextTokens)),
    turns,
    preamble,
    agents,
  };
}

export function sessionSummary(d: SessionDetail): SessionSummary {
  const { turns: _t, preamble: _p, agents: _a, ...rest } = d;
  return rest;
}

export function buildCallDetail(sessionCalls: ParsedCall[], id: string): CallDetail | null {
  const analysed = analyseSession(sessionCalls);
  const a = analysed.find((x) => x.call.id === id);
  if (!a) return null;
  const c = a.call;
  return {
    ...summarise(a, identifyAgents(analysed)),
    params: c.params,
    system: c.system,
    tools: c.tools,
    newMessages: c.messages.slice(a.newFromIndex),
    newFromIndex: a.newFromIndex,
    allMessages: c.messages,
    response: c.response,
    rawResponseError: c.error,
  };
}
