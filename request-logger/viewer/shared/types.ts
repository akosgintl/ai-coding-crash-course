// Shapes exchanged between the viewer's server (vite plugin) and the React UI.

export type Usage = {
  inputTokens: number; // fresh, uncached prompt tokens
  cacheCreationTokens: number; // prompt tokens written to cache
  cacheReadTokens: number; // prompt tokens read from cache
  outputTokens: number;
  thinkingTokens: number; // subset of outputTokens, when reported
};

/** main = the conversation you type into; subagent = Agent tool / other tool-bearing threads; side = tool-less helper calls (titles, summaries…) */
export type CallKind = "main" | "subagent" | "side";

/** Whose call it is, independent of kind: the main thread, a subagent thread, or neither (tool-less: title, quota). */
export type CallOwner = "main" | "subagent" | "session";

/** A content block, normalised from either a request message or a response stream. */
export type Block =
  | { type: "text"; text: string; injected: boolean } // injected = harness <system-reminder> etc.
  | { type: "thinking"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; text: string; isError: boolean }
  | { type: "other"; label: string; raw: string };

export type Message = { role: string; blocks: Block[] };

export type CallSummary = {
  id: string; // file base name
  timestamp: string; // ISO
  sessionId: string;
  model: string;
  kind: CallKind;
  /** side calls keep their owner: a prompt suggestion is main's, a progress summary is its subagent's */
  owner: CallOwner;
  threadId: string;
  /** the /compact summary call: history after it is replaced by its output */
  compaction: boolean;
  /** set when this call's thread shrank: history was rewound (Esc Esc / /rewind) to an earlier point */
  rewind: { keptMessages: number; droppedMessages: number } | null;
  label: string; // short human label (prompt excerpt, side-call purpose…)
  messageCount: number;
  toolCount: number;
  stopReason: string | null;
  error: string | null;
  usage: Usage | null;
  contextTokens: number; // input + cacheCreation + cacheRead
  /** Character share of the request, used to *estimate* the context breakdown. */
  chars: { system: number; tools: number; history: number; newContent: number };
  toolsUsed: string[]; // tool_use names in the response
  /** 1-based number of the subagent thread this call belongs to (its work and its side calls) */
  agentIndex: number | null;
};

/** One subagent: every call of a single subagent thread, linked to the Agent tool call that spawned it. */
export type AgentThread = {
  index: number; // 1-based, in order of first call
  threadId: string;
  description: string; // Agent tool `description`, or a prompt excerpt
  subagentType: string | null;
  /** main-thread call whose response contained the Agent tool_use */
  spawnedBy: string | null;
  toolUseId: string | null;
  /** the task the main agent gave it (Agent tool `prompt`) */
  prompt: string;
  /** what came back: the tool_result the main thread received, else the subagent's last text reply */
  result: string | null;
  /** main-thread call that first carried the result back */
  returnedIn: string | null;
  /** completed / failed / killed… (from the task notification), "error" for a failed tool_result; null while running */
  status: string | null;
  /** launched with run_in_background: the main thread kept working and got a <task-notification> later */
  background: boolean;
  /** when the main agent spawned it (timestamp of spawnedBy) */
  spawnedAt: string | null;
  model: string;
  /** the subagent's own work (usage/peak/time are computed from these) */
  calls: CallSummary[];
  /** housekeeping the harness ran on this subagent's thread (progress summaries…) */
  sideCalls: CallSummary[];
  usage: Usage;
  startedAt: string;
  endedAt: string;
  peakContextTokens: number;
};

export type Turn = {
  index: number;
  prompt: string;
  startedAt: string;
  calls: CallSummary[]; // main-thread calls in this turn
  /** subagent/side calls that happened while this turn was running */
  nested: CallSummary[];
  usage: Usage;
};

export type SessionSummary = {
  sessionId: string;
  title: string;
  startedAt: string;
  endedAt: string;
  callCount: number;
  turnCount: number;
  models: string[];
  usage: Usage;
  peakContextTokens: number;
};

export type SessionDetail = SessionSummary & {
  turns: Turn[];
  /** calls that came before the first main-thread turn (warm-up, titles…) */
  preamble: CallSummary[];
  /** subagent threads, each followed separately (they may have run in parallel) */
  agents: AgentThread[];
};

export type CallDetail = CallSummary & {
  params: Record<string, unknown>; // request fields other than messages/system/tools
  system: { text: string; cacheControl: string | null }[];
  tools: { name: string; description: string; chars: number }[];
  /** messages that were new in this request compared with the previous call in the thread */
  newMessages: Message[];
  /** index in the full message list where newMessages starts */
  newFromIndex: number;
  allMessages: Message[];
  response: Block[];
  rawResponseError: string | null;
};
