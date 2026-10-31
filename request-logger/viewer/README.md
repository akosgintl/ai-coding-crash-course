# Harness Inspector (request-logger viewer)

A standalone React + Vite UI for the captures in `request-logger/logs/`. It is
its own package — own `package.json`, `node_modules`, tsconfig and tests — and
shares nothing with the course app in `app/`.

```bash
npm --prefix request-logger/viewer install   # once
npm run logs-ui                               # from the repo root
```

Open http://localhost:5180. It listens on 127.0.0.1 only: the captures contain
your account and device ids. Point it at another folder with `LOGS_DIR=...`.

## What it shows

- **Sessions** — grouped by the `session_id` Claude Code puts in `metadata.user_id`.
- **Turns** — one per prompt you typed (or a message from another session),
  holding every API call until the model stops.
- **Call kinds**
  - `main` — your conversation thread.
  - `subagent` — threads with a different system prompt (e.g. the Agent tool).
  - `side` — housekeeping: tool-less calls (session title), and forks of a
    thread the harness sends on its own: prompt suggestions, progress
    summaries, away recaps, `/compact` summaries. Recognised by `HARNESS_FORKS` in `server/parse.ts`,
    or because the next call in the thread did not carry them forward.
- **Owner** (separate from kind) — a side call keeps the thread it forked
  from, because a fork reuses that thread's system prompt. So badges read
  `main`, `main · side` (prompt suggestions, away recaps), `subagent N`,
  `sub N · side` (progress summaries) and `session` (tool-less: title, quota).
  The colour is the owner's; side calls are hollow and dashed. Turns has a
  toggle for each group, plus one chip per subagent that hides everything it
  owns.
- **Subagents** — numbered by first call, each with its own colour (badges,
  row edges, chart strip, inspector), and named after the `Agent`/`Task` tool
  call that spawned it (its `prompt` reappears as the subagent's first
  message). The panel is a shared timeline: dashed = spawned but not yet
  running, bar = running, ticks = API calls (click to inspect), ◂ = when the
  main thread received the report. Click a row for the task, the report the
  main agent got, tool counts, token stats and every step. Background agents
  are followed through their hand-back: launch ack (`agentId`) →
  `<agent-message from="agentId">` (the report) → `<task-notification>`
  (status). In Turns, coloured chips filter subagents one by one.
- **Context window per call** — cache read / cache write / uncached input /
  output, straight from the response's `usage`. Dashed markers show
  `/compact` (amber, after the summary call) and rewinds (cyan, before the
  first call whose thread shrank while keeping its first message).
- **Call inspector → What's new** — each request resends the whole history,
  so the viewer diffs against the previous call in the same thread and shows
  only what the harness appended: tool results, `<system-reminder>`s (marked
  "injected by harness"), your prompt.
- **Context composition** — an *estimate*: the call's real token count split by
  the character share of system prompt, tool schemas, history and new content.

## How it works

`server/plugin.ts` is a Vite plugin that serves `/api/*` from the dev server
and pushes `/api/events` (SSE) when `fs.watch` sees a new `.response.txt`.
All parsing is pure and unit-tested in `server/parse.ts`.
