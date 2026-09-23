/**
 * pi-web-tools — Pi web tools under familiar names, one provider each.
 *
 *   web_search            -> Parallel Search API  (official parallel-web SDK)
 *   web_research (+_status) -> Parallel task runs (hosted deep research)
 *   web_fetch             -> local Firecrawl scrape (Camofox render path)
 *   web_browse_*          -> local Camofox anti-detection browser (REST)
 *
 * Replaces @parallel-web/pi-extension (search) and @narumitw/pi-firecrawl
 * (fetch) with a single extension that owns all the tool names, so the
 * vocabulary and descriptions are controlled here. No MCP.
 *
 * Env (read at tool execution time, never in this file):
 *   PARALLEL_API_KEY       required for web_search / web_research
 *   FIRECRAWL_API_URL      local Firecrawl (default http://127.0.0.1:3002/v1)
 *   FIRECRAWL_API_KEY      local Firecrawl auth
 *   CAMOFOX_URL            Camofox server (default http://127.0.0.1:9377)
 *   CAMOFOX_API_KEY        Camofox auth (optional)
 *
 * Layout:
 *   camofox.ts   — REST client + deterministic session identity (pure, testable)
 *   browse.ts    — web_browse_* tools + session lifecycle
 *   research.ts  — web_research / web_research_status
 *   this file    — web_search + web_fetch + factory wiring
 *
 * Deployment: symlink this directory into ~/.pi/agent/extensions/ (see
 * README.md). pi loads it via the "pi.extensions" manifest in package.json.
 */

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import Parallel from "parallel-web";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBrowse } from "./browse.js";
import { registerResearch } from "./research.js";

const FIRECRAWL_DEFAULT_URL = "http://127.0.0.1:3002/v1";
const MAX_URLS = 20;
const FETCH_CONCURRENCY = 3;

// One session id per extension load; Parallel uses it to correlate related
// search calls within the task (mirrors @parallel-web/pi-extension).
const parallelSessionId = randomUUID();

function apiUrl(): string {
  return (
    (process.env.FIRECRAWL_API_URL ?? process.env.FIRECRAWL_BASE_URL ?? FIRECRAWL_DEFAULT_URL)
      .trim()
      .replace(/\/+$/, "")
  );
}

function persistFullOutput(text: string): string | undefined {
  try {
    const file = join(tmpdir(), `pi-web-tools-${randomUUID().slice(0, 8)}.txt`);
    writeFileSync(file, text, "utf8");
    return file;
  } catch {
    return undefined;
  }
}

/**
 * Shape an arbitrary JSON payload into a bounded text tool result.
 * Truncates with pi's standard head-truncation; when truncated, persists the
 * full text to a temp file and includes its path so nothing is lost.
 */
function boundedJsonText(payload: unknown): string {
  const pretty = JSON.stringify(payload, null, 2) ?? String(payload);
  const truncated = truncateHead(pretty, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  if (!truncated.truncated) return truncated.content;
  const full = persistFullOutput(pretty);
  return (
    truncated.content +
    `\n\n[Output truncated: showing ${truncated.outputLines} of ${truncated.totalLines} lines, ${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}.${
      full ? ` Full output saved to ${full}.` : ""
    }]`
  );
}

function cleanObject(value: any): any {
  if (Array.isArray(value)) return value.map(cleanObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, cleanObject(v)]),
  );
}

export default function piWebTools(pi: ExtensionAPI) {
  // ---------------------------------------------------------------------
  // web_browse_* — Camofox (local anti-detection browser)
  // ---------------------------------------------------------------------
  registerBrowse(pi);

  // ---------------------------------------------------------------------
  // web_research (+ web_research_status) — Parallel task runs (deep research)
  // ---------------------------------------------------------------------
  registerResearch(pi);

  // ---------------------------------------------------------------------
  // web_search — Parallel Search API
  // ---------------------------------------------------------------------
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web using Parallel's Search API. Prefer this for current information, source discovery, and anything you are not highly confident about.",
    promptSnippet:
      "Search the web for current information and sources using Parallel's Search API",
    promptGuidelines: [
      "Use web_search when the task involves current information, external facts, source discovery, recent changes, or any claim you are not highly confident about.",
      "Provide 2-3 concise keyword search_queries (3-6 words each) and a self-contained objective.",
      "Use advanced_settings only when needed: restrict domains via source_policy, geo-target via location, or lower latency via mode: 'basic'.",
    ],
    parameters: Type.Object({
      objective: Type.String({
        description:
          "Natural-language description of the underlying question or goal driving the search. Must be self-contained.",
      }),
      search_queries: Type.Array(Type.String(), {
        description:
          "Concise keyword search queries, 3-6 words each. At least one; 2-3 is best.",
      }),
      advanced_settings: Type.Optional(
        Type.Object({
          mode: Type.Optional(Type.Union([Type.Literal("basic"), Type.Literal("advanced")])),
          max_results: Type.Optional(Type.Number()),
          location: Type.Optional(Type.String()),
          source_policy: Type.Optional(
            Type.Object({
              include_domains: Type.Optional(Type.Array(Type.String())),
              exclude_domains: Type.Optional(Type.Array(Type.String())),
              after_date: Type.Optional(Type.String()),
            }),
          ),
          excerpt_settings: Type.Optional(
            Type.Object({
              max_chars_per_result: Type.Optional(Type.Number()),
            }),
          ),
          fetch_policy: Type.Optional(
            Type.Object({
              max_age_seconds: Type.Optional(Type.Number()),
              timeout_seconds: Type.Optional(Type.Number()),
              disable_cache_fallback: Type.Optional(Type.Boolean()),
            }),
          ),
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const apiKey = process.env.PARALLEL_API_KEY?.trim();
      if (!apiKey) {
        throw new Error("PARALLEL_API_KEY is not set. Add it to the Pi environment, then retry.");
      }
      const client = new Parallel({ apiKey });
      const result = await client.search(
        cleanObject({
          objective: params.objective,
          search_queries: params.search_queries,
          advanced_settings: params.advanced_settings,
          client_model: ctx.model?.id,
          session_id: parallelSessionId,
        }),
        { signal },
      );
      return {
        content: [{ type: "text" as const, text: boundedJsonText(result) }],
        details: { provider: "parallel", product: "search" },
      };
    },
  });

  // ---------------------------------------------------------------------
  // web_fetch — local Firecrawl scrape (Camofox render path)
  // ---------------------------------------------------------------------
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch and extract readable content from one or more URLs via the local Firecrawl (browser-rendered markdown). Batch multiple URLs into one call.",
    promptSnippet:
      "Fetch readable, browser-rendered content from one or more URLs via local Firecrawl",
    promptGuidelines: [
      "Use web_fetch when the user provides one or more URLs and wants the page content, or when a search result should be verified against its source.",
      "Batch multiple URLs into one web_fetch call instead of making many single-URL calls.",
    ],
    parameters: Type.Object({
      urls: Type.Array(
        Type.String(),
        { description: `List of URLs to fetch. Must be valid HTTP/HTTPS URLs. Up to ${MAX_URLS}.` },
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
      if (!apiKey) {
        throw new Error("FIRECRAWL_API_KEY is not set. Add it to the Pi environment, then retry.");
      }
      const urls = params.urls.slice(0, MAX_URLS);

      type Out = { url: string; markdown?: string; error?: string };
      const out: Out[] = urls.map((url) => ({ url }));
      let idx = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = idx++;
          if (i >= urls.length) return;
          try {
            signal?.throwIfAborted();
            const res = await fetch(`${apiUrl()}/scrape`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                url: urls[i],
                formats: ["markdown"],
                onlyMainContent: true,
              }),
              signal,
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || body.success === false) {
              out[i].error = `HTTP ${res.status}` + (body?.error ? `: ${String(body.error).slice(0, 200)}` : "");
            } else {
              out[i].markdown = body?.data?.markdown ?? "";
            }
          } catch (e: any) {
            out[i].error = e?.name === "AbortError" ? "aborted" : String(e?.message ?? e).slice(0, 200);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(FETCH_CONCURRENCY, urls.length) }, () => worker()),
      );

      const parts: string[] = [];
      for (const o of out) {
        if (o.markdown !== undefined) {
          parts.push(`## ${o.url}\n\n${o.markdown}`);
        } else {
          parts.push(`## ${o.url}\n\n[fetch failed: ${o.error ?? "unknown error"}]`);
        }
      }
      const combined = parts.join("\n\n---\n\n");
      const truncated = truncateHead(combined, {
        maxLines: DEFAULT_MAX_LINES,
        maxBytes: DEFAULT_MAX_BYTES,
      });
      let text = truncated.content;
      if (truncated.truncated) {
        const full = persistFullOutput(combined);
        text +=
          `\n\n[Output truncated: showing ${truncated.outputLines} of ${truncated.totalLines} lines, ` +
          `${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}.` +
          (full ? ` Full output saved to ${full}.` : "") +
          " Re-fetch specific URLs to read the rest.]";
      }
      return {
        content: [{ type: "text" as const, text }],
        details: { provider: "firecrawl", product: "scrape", urls: urls.length },
      };
    },
  });
}
