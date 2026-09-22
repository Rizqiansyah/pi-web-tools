# pi-web-tools — Plan & Spec

A single Pi coding-agent extension that owns **both** web tools under the
familiar names, each pinned to one provider:

- `web_search` → **Parallel** Search API (official `parallel-web` SDK, v1.3.3)
- `web_fetch`  → **local Firecrawl** scrape (self-hosted, Camofox render path)

Replaces the two official npm packages (`@parallel-web/pi-extension`,
`@narumitw/pi-firecrawl`) plus the interim `web-split` routing extension, whose
tool names/descriptions we couldn't control and which can't be mixed.

## Why this shape (all verified against Pi 0.87.0 source)
- Pi has no tool rename/override primitive. `tool_call` hooks can only block or
  mutate args — they can't re-target a call to another tool.
- Two extensions registering the same tool name → load-time
  `detectExtensionConflicts` error (`core/resource-loader.js`). So to own the
  name `web_fetch` with a Firecrawl backend, the Parallel package must go —
  and then `web_search` has a home only here too.
- `getAllRegisteredTools()` is first-registration-wins, but the conflict check
  makes "shadowing" impossible regardless of load order.
- Net: one local plugin = the entire web seam. `web_search` + `web_fetch`,
  familiar names, descriptions fully ours.

## Verified wire contracts (from installed SDK, not docs)
- Parallel search: `POST https://api.parallel.ai/v1/search` (base overridable
  via `PARALLEL_BASE_URL`), auth header `x-api-key: <key>`, body
  `{ objective, search_queries, advanced_settings?, client_model?, session_id? }`.
  SDK class: `new Parallel({ apiKey }).search(body, { signal })`.
- Firecrawl scrape: `POST $FIRECRAWL_API_URL/scrape` (default
  `http://127.0.0.1:3002/v1`), `Authorization: Bearer $FIRECRAWL_API_KEY`,
  body `{ url, formats: ["markdown"], onlyMainContent: true }`. Response
  `{ success, data: { markdown, metadata } }` (live-verified 2026-09-22).

## Repo layout
```
~/ai/pi-web-tools/
  index.ts            # extension: registers web_search + web_fetch
  package.json        # name, pi manifest ("pi.extensions"), deps
  package-lock.json
  .gitignore          # node_modules/
  README.md           # install + usage + env
  SPEC.md             # this file
  tsconfig.json       # type-check only (dev)
```
Deploy (proven via probe 2026-09-23): `ln -s ~/ai/pi-web-tools
~/.pi/agent/extensions/pi-web-tools`. Pi discovers subdirs with a
`package.json` carrying a `pi.extensions` manifest in `agentDir/extensions/`
and loads the listed entry via jiti; jiti follows the symlink and resolves
`parallel-web` from the repo's own `node_modules` (a plain `import
"parallel-web"` from `~/.pi/agent/extensions/*` does **not** resolve — the
SDK lives under `~/.pi/agent/npm/node_modules`, a sibling that jiti doesn't
walk).

## Tool contracts

### web_search (Parallel)
- `objective: string` (required) — natural-language goal.
- `search_queries: string[]` (required) — 2–3 concise queries, 3–6 words each.
- optional `advanced_settings` (typed, passed through to Parallel):
  - `mode: "basic" | "advanced"`
  - `max_results?: number`
  - `location?: string` (ISO 3166-1 alpha-2 country)
  - `source_policy?: { include_domains?, exclude_domains?, after_date? }`
  - `excerpt_settings?: { max_chars_per_result? }`
  - `fetch_policy?: { max_age_seconds?, timeout_seconds?, disable_cache_fallback? }`
- exec: `client.search({ objective, search_queries, advanced_settings,
  client_model: ctx.model?.id, session_id })`; result JSON truncated with Pi's
  `truncateHead` (`DEFAULT_MAX_LINES=2000` / `DEFAULT_MAX_BYTES=51200`), full
  output persisted to a temp file with its path returned when truncated.

### web_fetch (local Firecrawl)
- `urls: string[]` (required, ≤20) — batch multiple URLs in one call.
- exec: per-URL `POST /scrape` with concurrency 3, per-URL error isolation
  (one dead URL doesn't sink the batch), combined markdown in input order,
  same `truncateHead` + persist-full behavior.

## Env (read at execution time; no keys in code or repo)
- `PARALLEL_API_KEY` — required for web_search
- `FIRECRAWL_API_URL` — optional, default `http://127.0.0.1:3002/v1`
- `FIRECRAWL_API_KEY` — required for web_fetch (our instance doesn't enforce
  it, but the header is always sent)
All three already exist in `~/.config/pichamber/env`.

## Phases (atomic commits)
1. `chore: scaffold repo` — package.json (pi manifest), package-lock,
   .gitignore, SPEC.md, README.md, tsconfig.json
2. `feat: web_fetch via local Firecrawl` — index.ts with web_fetch only
3. `feat: web_search via Parallel SDK` — add web_search
4. deploy (live, not in repo): remove `web-split` extension (moved to
   backup), `pi remove` both official packages, delete `pi-firecrawl.json`,
   symlink repo in, boot test
5. `test: e2e verification` — wire loadout capture + real search + real fetch,
   results appended to README (or this file)

Rollback: `pi install` both official packages back, restore `web-split` from
backup, remove symlink, restore `~/.pi/agent/settings.json` from
`settings.json.bak-webfetch-20260923-0108`.

## Out of scope (phase 2+)
- `web_browse` (Camofox REST, Hermes-style refs) — spec after phase 1
- `web_research` (Parallel task runs, async deep research)
- Parallel monitors (web change tracking; needs a webhook receiver)
