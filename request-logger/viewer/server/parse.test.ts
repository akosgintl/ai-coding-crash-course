import { describe, expect, it } from "vitest";
import { analyseSession, buildCallDetail, buildSession, parseCapture, parseResponse, timestampFromBase } from "./parse";

const SID = "11111111-2222-3333-4444-555555555555";
const meta = { user_id: JSON.stringify({ device_id: "d", session_id: SID }) };
const MAIN_SYSTEM = [{ type: "text", text: "You are the main agent." }];
const TOOLS = [{ name: "Bash", description: "run", input_schema: {} }];

function req(messages: unknown[], extra: Record<string, unknown> = {}) {
  return JSON.stringify({ model: "claude-x", system: MAIN_SYSTEM, tools: TOOLS, metadata: meta, messages, ...extra });
}

function sse(blocks: string[], usage = { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 5 }, stop = "end_turn") {
  const lines = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { ...usage, output_tokens: 1 } } })}`,
    ...blocks,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: stop }, usage })}`,
  ];
  return lines.join("\n\n");
}
const textBlock = (i: number, t: string) =>
  [
    `data: ${JSON.stringify({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } })}`,
    `data: ${JSON.stringify({ type: "content_block_delta", index: i, delta: { type: "text_delta", text: t } })}`,
  ].join("\n");
const toolBlock = (i: number, id: string, name: string, json: string) =>
  [
    `data: ${JSON.stringify({ type: "content_block_start", index: i, content_block: { type: "tool_use", id, name, input: {} } })}`,
    `data: ${JSON.stringify({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: json.slice(0, 5) } })}`,
    `data: ${JSON.stringify({ type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: json.slice(5) } })}`,
  ].join("\n");

const u = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const reminder = { type: "text", text: "<system-reminder>be nice</system-reminder>" };

describe("parseResponse", () => {
  it("assembles streamed text, tool input and usage", () => {
    const r = parseResponse(sse([textBlock(0, "hi"), toolBlock(1, "t1", "Bash", '{"command":"ls"}')], undefined, "tool_use"));
    expect(r.blocks).toEqual([
      { type: "text", text: "hi", injected: false },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
    ]);
    expect(r.stopReason).toBe("tool_use");
    expect(r.usage).toMatchObject({ inputTokens: 2, cacheReadTokens: 100, cacheCreationTokens: 10, outputTokens: 5 });
  });

  it("reports JSON error bodies", () => {
    const r = parseResponse('{"type":"error","error":{"type":"rate_limit_error","message":"Error"}}');
    expect(r.error).toBe("rate_limit_error: Error");
    expect(r.usage).toBeNull();
  });
});

describe("parseCapture", () => {
  it("reads the session id, system cache breakpoints and injected text", () => {
    const c = parseCapture(
      "2026-10-31T16-31-06-570_claude-code",
      JSON.stringify({
        model: "m",
        metadata: meta,
        system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [{ role: "user", content: [reminder, { type: "text", text: "hello" }] }],
      }),
      sse([textBlock(0, "x")]),
    );
    expect(c.sessionId).toBe(SID);
    expect(c.timestamp).toBe("2026-10-31T16:31:06.570Z");
    expect(c.system[0].cacheControl).toBe("ephemeral 1h");
    expect(c.messages[0].blocks.map((b) => (b as any).injected)).toEqual([true, false]);
  });

  it("treats string and block-array content of the same message as equal", () => {
    const a = parseCapture("a", req([{ role: "user", content: "hello" }]), "");
    const b = parseCapture("b", req([{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }]), "");
    expect(a.firstMessageKey).toBe(b.firstMessageKey);
  });
});

describe("timestampFromBase", () => {
  it("converts file base names to ISO", () => {
    expect(timestampFromBase("2026-01-02T03-04-05-006_x")).toBe("2026-01-02T03:04:05.006Z");
  });
});

describe("session analysis", () => {
  // Turn 1: prompt -> tool call -> tool result -> answer. Then a prompt-suggestion fork. Turn 2: new prompt.
  const m1 = [{ role: "user", content: [reminder, { type: "text", text: "list files" }] }];
  const a1 = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] };
  const r1 = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "a.txt" }] };
  const a2 = { role: "assistant", content: [{ type: "text", text: "a.txt" }] };

  const calls = [
    parseCapture("2026-01-01T00-00-00-000_x", JSON.stringify({ model: "m", metadata: meta, tools: [], system: [{ type: "text", text: "title" }], messages: [u("list files")], output_config: { format: { schema: { properties: { title: {} } } } } }), JSON.stringify({ type: "message", content: [{ type: "text", text: '{"title":"Listing files"}' }], usage: { input_tokens: 5, output_tokens: 3 } })),
    parseCapture("2026-01-01T00-00-01-000_x", req(m1), sse([toolBlock(0, "t1", "Bash", '{"command":"ls"}')], undefined, "tool_use")),
    parseCapture("2026-01-01T00-00-02-000_x", req([...m1, a1, r1]), sse([textBlock(0, "a.txt")])),
    parseCapture("2026-01-01T00-00-03-000_x", req([...m1, a1, r1, a2, u("[SUGGESTION MODE: guess]")]), sse([textBlock(0, "thanks")])),
    parseCapture("2026-01-01T00-00-09-000_x", req([...m1, a1, r1, a2, u("now count them")]), sse([textBlock(0, "1")])),
    // subagent: different system prompt
    parseCapture("2026-01-01T00-00-10-000_x", JSON.stringify({ model: "m", metadata: meta, tools: TOOLS, system: [{ type: "text", text: "You are a subagent." }], messages: [u("explore")] }), sse([textBlock(0, "done")])),
  ];

  it("classifies main, subagent, side and harness forks", () => {
    const a = analyseSession(calls);
    expect(a.map((x) => x.kind)).toEqual(["side", "main", "main", "side", "main", "subagent"]);
    expect(a[3].label).toMatch(/prompt suggestion/);
    expect(a[0].label).toBe("session title: “Listing files”");
  });

  it("groups calls into turns, with nested side/subagent calls", () => {
    const s = buildSession(calls);
    expect(s.title).toBe("Listing files");
    expect(s.turnCount).toBe(2);
    expect(s.preamble.map((c) => c.kind)).toEqual(["side"]);
    expect(s.turns[0].prompt).toBe("list files");
    expect(s.turns[0].calls).toHaveLength(2);
    expect(s.turns[0].nested.map((c) => c.kind)).toEqual(["side"]);
    expect(s.turns[1].prompt).toBe("now count them");
    expect(s.turns[1].nested.map((c) => c.kind)).toEqual(["subagent"]);
  });

  it("shows only what the harness appended since the previous call", () => {
    const d = buildCallDetail(calls, "2026-01-01T00-00-02-000_x")!;
    expect(d.newFromIndex).toBe(2); // skips history and the model's own previous reply
    expect(d.newMessages).toHaveLength(1);
    expect(d.newMessages[0].blocks[0].type).toBe("tool_result");
    expect(d.label).toBe("tool results → Bash");
  });

  it("flags a rewind, restarts the turn and diffs from the kept prefix", () => {
    const deep = u("go deeper");
    const r = [
      parseCapture("2026-01-01T00-00-01-000_x", req([...m1, a1, r1, a2, deep]), sse([toolBlock(0, "t2", "Bash", '{"command":"ls"}')], undefined, "tool_use")),
      parseCapture("2026-01-01T00-00-02-000_x", req([...m1, a1, r1, a2, deep, { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "x" }] }]), sse([textBlock(0, "long answer")])),
      // rewound to just after "go deeper", same prompt re-run
      parseCapture("2026-01-01T00-00-09-000_x", req([...m1, a1, r1, a2, deep]), sse([textBlock(0, "different answer")])),
    ];
    const a = analyseSession(r);
    expect(a[1].label).toMatch(/^rewound away/);
    expect(a[2].rewind).toEqual({ keptMessages: 5, droppedMessages: 2 });
    expect(a[2].startsTurn).toBe(true);
    expect(a[2].label).toMatch(/^↶ rewind \(kept 5 msgs\): go deeper/);
    expect(a[2].newFromIndex).toBe(5);
  });

  it("keeps the thread main across /compact, though the billing header changes", () => {
    const sys = (v: string) => [{ type: "text", text: `x-anthropic-billing-header: cc_version=1.0.${v};` }, ...MAIN_SYSTEM];
    const compact = [
      parseCapture("2026-01-01T00-00-01-000_x", req(m1, { system: sys("aaa") }), sse([textBlock(0, "ok")])),
      parseCapture("2026-01-01T00-00-02-000_x", req([...m1, a2, u("Your task is to create a detailed summary of the conversation so far")], { system: sys("aaa") }), sse([textBlock(0, "<summary>")])),
      parseCapture("2026-01-01T00-00-03-000_x", req([u("This session is being continued… summary"), u("next question")], { system: sys("bbb") }), sse([textBlock(0, "answer")])),
    ];
    const a = analyseSession(compact);
    expect(a.map((x) => x.kind)).toEqual(["main", "side", "main"]);
    expect(a[1].label).toMatch(/^compaction/);
    expect(a[2].startsTurn).toBe(true);
    const s = buildSession(compact);
    const all = [...s.preamble, ...s.turns.flatMap((t) => [...t.calls, ...t.nested])];
    expect(all.filter((c) => c.compaction).map((c) => c.id)).toEqual(["2026-01-01T00-00-02-000_x"]);
  });
});

describe("subagents", () => {
  it("numbers parallel subagent threads and links each to its Agent tool call", () => {
    const SUB = [{ type: "text", text: "You are a subagent." }];
    const spawn = [
      toolBlock(0, "a1", "Agent", JSON.stringify({ description: "Look at A", subagent_type: "Explore", prompt: "Study area A" })),
      toolBlock(1, "a2", "Agent", JSON.stringify({ description: "Look at B", subagent_type: "Explore", prompt: "Study area B" })),
    ];
    const sub = (prompt: string, more: unknown[] = []) => req([{ role: "user", content: [reminder, { type: "text", text: prompt }] }, ...more], { system: SUB });
    const files: [string, string, string][] = [
      ["2026-01-01T00-00-00-000_x", req([u("go")]), sse(spawn, undefined, "tool_use")],
      // B starts first, so it is subagent 1 — but still linked to the "Look at B" spawn.
      ["2026-01-01T00-00-01-000_x", sub("Study area B"), sse([toolBlock(0, "b1", "Bash", '{"command":"ls"}')], undefined, "tool_use")],
      ["2026-01-01T00-00-01-001_x", sub("Study area A"), sse([textBlock(0, "A done")])],
      [
        "2026-01-01T00-00-02-000_x",
        sub("Study area B", [
          { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "x" }] },
        ]),
        sse([textBlock(0, "B done")]),
      ],
      [
        "2026-01-01T00-00-03-000_x",
        req([
          u("go"),
          { role: "assistant", content: [{ type: "tool_use", id: "a1", name: "Agent", input: {} }, { type: "tool_use", id: "a2", name: "Agent", input: {} }] },
          { role: "user", content: [
            { type: "tool_result", tool_use_id: "a1", content: [{ type: "text", text: "A report" }] },
            { type: "tool_result", tool_use_id: "a2", content: "B report" },
          ] },
        ]),
        sse([textBlock(0, "summary")]),
      ],
    ];
    const s = buildSession(files.map(([id, r, s]) => parseCapture(id, r, s)));
    expect(s.agents.map((a) => [a.index, a.description, a.subagentType, a.toolUseId, a.calls.length])).toEqual([
      [1, "Look at B", "Explore", "a2", 2],
      [2, "Look at A", "Explore", "a1", 1],
    ]);
    expect(s.agents[0]).toMatchObject({
      spawnedBy: "2026-01-01T00-00-00-000_x",
      spawnedAt: "2026-01-01T00:00:00.000Z",
      prompt: "Study area B",
      result: "B report",
      returnedIn: "2026-01-01T00-00-03-000_x",
    });
    expect(s.agents[1].result).toBe("A report");
    expect(s.turns[0].nested.map((c) => c.agentIndex)).toEqual([1, 2, 1]);
  });
});

describe("background subagents", () => {
  it("takes the report from the <agent-message> hand-back, status from the task notification", () => {
    const SUB = [{ type: "text", text: "You are a subagent." }];
    const spawn = toolBlock(0, "a1", "Agent", JSON.stringify({ description: "Bg job", prompt: "Do X", run_in_background: true }));
    const ack = "Async agent launched successfully.\nagentId: abc123 (internal ID)\nThe agent is working in the background.";
    const handBack =
      'Another Claude session sent a message:\n<agent-message from="abc123">\n[Subagent hand-back] Notes. The report follows:\n  # Report\n  \n  line two\n</agent-message>';
    const notification =
      "<system-reminder>\n<task-notification>\n<task-id>abc123</task-id>\n<tool-use-id>a1</tool-use-id>\n<status>completed</status>\n<result>This agent's report was delivered to you as a message.</result>\n</task-notification>\n</system-reminder>";
    const history = [
      u("go"),
      { role: "assistant", content: [{ type: "tool_use", id: "a1", name: "Agent", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a1", content: ack }] },
    ];
    const files: [string, string, string][] = [
      ["2026-01-01T00-00-00-000_x", req([u("go")]), sse([spawn], undefined, "tool_use")],
      ["2026-01-01T00-00-01-000_x", req([{ role: "user", content: [{ type: "text", text: "Do X" }] }], { system: SUB }), sse([textBlock(0, "raw")])],
      ["2026-01-01T00-00-01-500_x", req(history), sse([textBlock(0, "waiting")])],
      [
        "2026-01-01T00-00-02-000_x",
        req([...history, { role: "assistant", content: [{ type: "text", text: "waiting" }] }, { role: "user", content: [{ type: "text", text: notification }, { type: "text", text: handBack }] }]),
        sse([textBlock(0, "got it")]),
      ],
    ];
    const s = buildSession(files.map(([id, r, s]) => parseCapture(id, r, s)));
    expect(s.agents[0]).toMatchObject({
      background: true,
      status: "completed",
      result: "# Report\n\nline two",
      returnedIn: "2026-01-01T00-00-02-000_x",
    });
  });
});

describe("owner × kind", () => {
  it("keeps the owner of side calls: main fork, subagent fork, tool-less session call", () => {
    const SUB = [{ type: "text", text: "You are a subagent." }];
    const spawn = toolBlock(0, "a1", "Agent", JSON.stringify({ description: "Job", prompt: "Do X" }));
    const subFirst = { role: "user", content: [{ type: "text", text: "Do X" }] };
    const files: [string, string, string][] = [
      ["2026-01-01T00-00-00-000_x", req([u("go")]), sse([spawn], undefined, "tool_use")],
      ["2026-01-01T00-00-00-500_x", JSON.stringify({ model: "m", metadata: meta, messages: [u("title please")] }), sse([textBlock(0, "t")])],
      ["2026-01-01T00-00-01-000_x", req([subFirst], { system: SUB }), sse([toolBlock(0, "b1", "Bash", '{"command":"ls"}')], undefined, "tool_use")],
      [
        "2026-01-01T00-00-01-500_x",
        req([subFirst, { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: {} }] }, u("Describe your most recent action in 3-5 words")], { system: SUB }),
        sse([textBlock(0, "Listing files")]),
      ],
      [
        "2026-01-01T00-00-02-000_x",
        req([subFirst, { role: "assistant", content: [{ type: "tool_use", id: "b1", name: "Bash", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "b1", content: "x" }] }], { system: SUB }),
        sse([textBlock(0, "done")]),
      ],
      ["2026-01-01T00-00-03-000_x", req([u("go"), { role: "assistant", content: [{ type: "text", text: "ok" }] }, u("[SUGGESTION MODE] guess")]), sse([textBlock(0, "next?")])],
    ];
    const s = buildSession(files.map(([id, r, s]) => parseCapture(id, r, s)));
    const all = [...s.preamble, ...s.turns.flatMap((t) => [...t.calls, ...t.nested])].sort((a, b) => a.id.localeCompare(b.id));
    expect(all.map((c) => [c.kind, c.owner, c.agentIndex])).toEqual([
      ["main", "main", null],
      ["side", "session", null],
      ["subagent", "subagent", 1],
      ["side", "subagent", 1],
      ["subagent", "subagent", 1],
      ["side", "main", null],
    ]);
    expect(s.agents[0].calls.map((c) => c.id)).toEqual(["2026-01-01T00-00-01-000_x", "2026-01-01T00-00-02-000_x"]);
    expect(s.agents[0].sideCalls.map((c) => c.id)).toEqual(["2026-01-01T00-00-01-500_x"]);
  });
});
