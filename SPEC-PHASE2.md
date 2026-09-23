# pi-web-tools — Phase 2: web_browse + web_research

Extends the existing single extension (`web_search` → Parallel, `web_fetch` →
local Firecrawl) with two more capabilities, one provider each, no MCP:

- **`web_browse_*`** → local **Camofox** anti-detection browser (v1.14.0, `:9377`),
  driven over its REST API. Mirrors the **Hermes** `browser_*` architecture (primary
  reference); DSH is secondary and confirms the seam (DSH has no first-class browse
  tool — its browse is indirect Firecrawl→Camofox).
- **`web_research`** → **Parallel** task runs (hosted async deep-research via the
  `parallel-web` SDK), a thin optional add-on.

All contracts below were verified **live against the running camofox-browser
v1.14.0** on this box (2026-09-23) and against the installed `parallel-web`
SDK v1.3.3.

## Design decisions (and why)

**Tool surface = fine-grained `web_browse_*` family, mirroring Hermes.**
Hermes exposes ~13 thin `browser_*` tools (navigate/snapshot/click/type/press/
scroll/back/forward/refresh/screenshot/links/get_images/evaluate) over a pluggable
backend. We mirror that shape (the user's primary reference) rather than a single
multiplexed `web_browse(action=...)` tool, because: (a) each tool's params are
exactly what it needs → fewer model mistakes; (b) each gets a crisp one-liner in
Pi's "Available tools" + Guidelines; (c) it is the architecture the user pointed at.
The shared machinery (session lifecycle + REST client + ref validation) is written
once; each tool is a thin wrapper.

**Session identity keyed on the Pi session id.** Hermes keys Camofox identity on
`task_id`. We use `ctx.sessionManager.getSessionId()` → deterministic
`userId`/`sessionKey` (UUIDv5 of the session id). One Pi session = one Camofox
session; browser state (cookies, logins, JS state) persists across the tool calls
within a session and is torn down at session end.

**`evaluate` is read-only by policy** (mirrors Hermes browser-discipline): input-
generating actions go through the humanized `click`/`type`/`press` (Camofox does
real humanized mouse/keyboard), never through raw JS. `web_browse_evaluate` is for
reading/verification only (enforced by description + prompt guideline, not a hard
block — blocking would kill legit read-only JS; Hermes does the same).

**Screenshots return a file path, not inlined bytes.** A 340KB PNG inlined into
the model context every call is expensive; `web_browse_screenshot` persists to a
temp file and returns the path (consistent with how `web_fetch` persists truncated
output). Inline vision is a one-line change later if wanted.

## Camofox REST contract (verified live, v1.14.0)

- `POST /tabs` body `{userId, sessionKey, url?}` → `{tabId, url}`. (Hermes's older
  `listItemId` field is obsolete on 1.14.0 — this server requires `sessionKey`.)
- `POST /tabs/{id}/navigate` `{userId, url}` → `{ok, tabId, url, refsAvailable}`
- `GET  /tabs/{id}/snapshot?userId=` → `{url, snapshot, refsCount, truncated, totalChars}`
  where `snapshot` is an **accessibility tree with `[eN]` refs**, e.g.
  `- link "Learn more" [e1]:\n  - /url: https://iana.org/domains/example`
- `POST /tabs/{id}/click`  `{userId, ref:"e1"}` → `{ok, url, refsAvailable, timings:{moveMs,wanderMs}}` (humanized)
- `POST /tabs/{id}/type`   `{userId, ref, text}` → ok (500 if ref is not an editable field)
- `POST /tabs/{id}/press`  `{userId, key}` → `{ok}`
- `POST /tabs/{id}/scroll` `{userId, direction}` → `{ok}`
- `POST /tabs/{id}/back|forward|refresh` `{userId}` → `{ok, url?}`
- `GET  /tabs/{id}/links?userId=` → `{links:[{url,text}]}`
- `GET  /tabs/{id}/screenshot?userId=` → `image/png` bytes
- `POST /tabs/{id}/evaluate` `{userId, expression}` → `{ok, result}`
- `POST /tabs/{id}/wait`     `{userId, timeout?}` → `{ok, ready}`
- `GET  /tabs` → `{running, tabs:[]}`
- `DELETE /sessions/{userId}` → `{ok:true}` (idempotent — 200 even if gone)
- Stale/dead tab → `404 {"error":"Tab not found"}` → we recreate transparently.

## `web_browse_*` tools (Phase 2A)

| tool | params | → Camofox | notes |
|---|---|---|---|
| `web_browse_navigate` | `url` | `/tabs` (create-or-reuse) + `/navigate` | lazily creates the session tab; returns url + `refsAvailable` |
| `web_browse_snapshot` | — | `/snapshot` | core read; returns accessibility tree w/ `[eN]`; head-truncated w/ full-to-disk if huge (server supports `offset` pagination if ever needed) |
| `web_browse_click` | `ref` | `/click` | ref like `e1` (auto-`@`/`e`-normalized) |
| `web_browse_type` | `ref`,`text` | `/type` | into an editable field |
| `web_browse_press` | `key` | `/press` | e.g. `Enter`, `Tab`, `Escape` |
| `web_browse_scroll` | `direction`,`amount?` | `/scroll` | up/down |
| `web_browse_back` | — | `/back` | history |
| `web_browse_forward` | — | `/forward` | history |
| `web_browse_refresh` | — | `/refresh` | |
| `web_browse_links` | `limit?` | `/links` | url+text list |
| `web_browse_screenshot` | — | `/screenshot` | persists PNG → returns path |
| `web_browse_evaluate` | `expression` | `/evaluate` | **read-only** (policy) |
| `web_browse_close` | — | `DELETE /sessions/{userId}` | explicit teardown |

Lifecycle: on `session_shutdown` + `agent_end` (idempotent) → `DELETE /sessions/{userId}`
so no tabs leak. Per-session `tabId` cached in a module-level `Map<sessionId, tabId>`
(Hermes `_sessions` pattern); recreated on any 404.

## `web_research` (Phase 2B, optional add-on)

One tool wrapping the Parallel SDK `client.taskRun`:
- `web_research({objective, processor?, output_schema?, timeout?})`
- `client.taskRun.create({input: objective, processor: processor ?? 'base'})`
  → returns `{run_id, status:'queued'}` immediately
- `client.taskRun.result(run_id, {timeout})` → **blocks** until done →
  `{output:{type:'text', content, citations:[{url,title,excerpts?}]}, run}`
- Returns the research text + a compact citations list + source stats.
- `processor` defaults to `base` (cheapest); the user can pass a stronger one.
- Long-running: `timeout` is a query param on `/result`; we default it high and
  document that this is an async hosted run, not a local call.

## Files (small, single-concern, each independently testable/rollback-able)

- `camofox.ts` — pure REST client + identity/session helpers (no Pi imports). Unit-testable.
- `browse.ts` — session lifecycle + `registerBrowse(pi)`. Depends on `camofox.ts`.
- `research.ts` — `registerResearch(pi)` (`web_research`). Depends on `parallel-web`.
- `index.ts` — registers search + fetch (existing) and calls `registerBrowse`/`registerResearch`.

## Atomic commit plan

1. `camofox.ts` — REST client + identity (contract-tested live)
2. `browse.ts` — lifecycle + `web_browse_*` registration
3. wire `browse.ts` into `index.ts` + deploy + e2e (navigate→snapshot→click→type→screenshot)
4. `research.ts` — `web_research` (Parallel task runs)
5. wire `research.ts` into `index.ts` + e2e + record verification in README/SPEC

Rollback is per-commit (git) and per-deploy (symlink swap). Existing phase-1 tools
(`web_search`, `web_fetch`) are untouched until the final wiring commit.

## Out of scope (deferred, documented)

- `monitors` (web-change watchers) — needs a webhook receiver endpoint; its own project.
- `extract` (Parallel hosted extraction) — overlaps `web_fetch`; not used.
- Inline screenshot vision — off by default (path returned).
- Multi-tab per session — single tab reused (Hermes default); easy to add.
