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

## Using it with another repo's request-logger

The viewer only needs a folder of captures (`*.request.txt` + `*.response.txt`
pairs written by `request-logger/proxy.ts`). It never imports the proxy, so
there are two ways to use it elsewhere.

### Option A — no copy: point this viewer at the other logs folder

```bash
LOGS_DIR=/home/gintla/projects/cohort-005-project/request-logger/logs \
  npm --prefix request-logger/viewer run dev
```

Run it from this repo. The other repo is not touched, and new captures appear
live because the viewer watches whatever `LOGS_DIR` points to. Only one viewer
can run at a time, because the port is fixed at 5180 (`strictPort`).

### Option B — copy the viewer into the other repo

Steps, with `cohort-005-project` as the example target, which has the same
`request-logger/` layout:

1. **Copy the package without its dependencies or build output:**

   ```bash
   rsync -a --exclude node_modules --exclude dist \
     request-logger/viewer/ /home/gintla/projects/cohort-005-project/request-logger/viewer/
   ```

   By default it reads `../logs` relative to itself (`vite.config.ts`), so
   `request-logger/viewer` next to `request-logger/logs` works with no config.
2. **Install its own dependencies.** It is a standalone package, with its own
   `package.json`, lockfile and `.gitignore` for `node_modules`:

   ```bash
   npm --prefix request-logger/viewer install
   ```

3. **Add the start script** to the target's root `package.json`:

   ```json
   "logs-ui": "npm --prefix request-logger/viewer run dev"
   ```

4. **Keep the root tooling out of the viewer.** Without this, the root
   `tsc`/`vitest` pick up its files and fail, because it has a different
   tsconfig and no `~/*` paths.
   - In the root `tsconfig.json`, `"include": ["**/*"]` matches the viewer, so add:

     ```json
     "exclude": ["node_modules", "request-logger/viewer"],
     ```

   - In the root `vitest.config.ts`, add it to `test.exclude`:

     ```ts
     exclude: [...configDefaults.exclude, "request-logger/viewer/**"],
     ```

5. **Check that the logs stay out of git.** The target's `.gitignore` should
   already have `/request-logger/logs/*`; the captures contain your prompts,
   code and account/device ids.
6. **Verify the copy:**

   ```bash
   npm --prefix request-logger/viewer run typecheck
   npm --prefix request-logger/viewer test
   npm run logs-ui     # → http://localhost:5180
   ```

**Keeping copies in sync:** the copy does not follow this one, so fixes such as
new `HARNESS_FORKS` patterns in `server/parse.ts` have to be re-copied. Repeat
step 1; rsync keeps the other repo's `node_modules`. If you want one source of
truth instead, use Option A.

## How it works

`server/plugin.ts` is a Vite plugin that serves `/api/*` from the dev server
and pushes `/api/events` (SSE) when `fs.watch` sees a new `.response.txt`.
All parsing is pure and unit-tested in `server/parse.ts`.
