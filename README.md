# pi-web-tools

Pi coding-agent extension that owns both web tools under the familiar names,
one provider per capability:

- **`web_search`** → Parallel Search API (official `parallel-web` SDK)
- **`web_fetch`** → local Firecrawl scrape (self-hosted, Camofox render path)

Replaces `@parallel-web/pi-extension` (search) and `@narumitw/pi-firecrawl`
(fetch). Pi hard-errors when two extensions register the same tool name, so a
single extension owns both — this also lets us control the tool names,
descriptions, and prompt guidance directly.

## Install

```bash
# 1. clone + install deps (repo carries its own node_modules; pi's jiti
#    loader resolves parallel-web from here — see SPEC.md for why)
git clone git@github.com:Rizqiansyah/pi-web-tools.git ~/ai/pi-web-tools
cd ~/ai/pi-web-tools && npm install

# 2. link into the pi agent extensions dir (pi discovers the package.json
#    "pi.extensions" manifest and loads index.ts)
ln -s ~/ai/pi-web-tools ~/.pi/agent/extensions/pi-web-tools

# 3. environment (must be visible to the pi process — for PiChamber, that's
#    ~/.config/pichamber/env, then restart the service)
#   PARALLEL_API_KEY      required for web_search
#   FIRECRAWL_API_URL     optional, default http://127.0.0.1:3002/v1
#   FIRECRAWL_API_KEY     required for web_fetch

# 4. remove the replaced official packages (if present)
cd ~/.pi/agent && pi remove npm:@parallel-web/pi-extension && pi remove npm:@narumitw/pi-firecrawl
```

## Usage

Both tools are registered unconditionally and appear in the default loadout.

- `web_search` — `objective` (required), `search_queries` (required, 2-3
  queries), optional `advanced_settings` (`mode`, `max_results`, `location`,
  `source_policy.include/exclude_domains`, `after_date`, excerpt/fetch policy).
- `web_fetch` — `urls` (required, up to 20, batched into one call). Returns
  browser-rendered markdown per URL; a failing URL is reported inline without
  sinking the batch. Output is head-truncated at pi's standard limits
  (2000 lines / 50KB); the full text is persisted to a temp file and its path
  is returned in the truncation note.

## Dev

- `npm run typecheck` — type-checks `index.ts` against the installed
  `@earendil-works/pi-coding-agent` (path-mapped in tsconfig.json).

## Specs & design rationale

See [SPEC.md](SPEC.md): wire contracts (verified from the installed SDK),
deployment mechanism, env, rollback, and phase-2 scope (`web_browse`,
`web_research`, Parallel monitors).

## Verification (2026-09-23, Pi 0.87.0)

Deployed as `~/.pi/agent/extensions/pi-web-tools` (symlink), both official web
plugins removed, interim `web-split` superseded. All checks against a live
pi process with the real env (keys never printed):

- Boot: clean, no load errors, no tool-name conflicts
- Wire (37 tools sent to the model): `web_search` + `web_fetch` present;
  `firecrawl_scrape`/`firecrawl_search` absent; no Parallel grounding block;
  the only "Firecrawl" mention is our own `web_fetch` description
- Functional: `web_search` → Parallel Search API → "Canberra" (capital of
  Australia); `web_fetch` → local Firecrawl/Camofox → "Example Domain"
  (H1 of example.com)

Type-check: `npm run typecheck` clean against the installed pi SDK
(path-mapped in tsconfig.json).
