/**
 * pi-web-tools — Pi web tools under familiar names, one provider each.
 *
 *   web_fetch  -> local Firecrawl scrape (Camofox render path)
 *   web_search -> Parallel Search API  (official parallel-web SDK)
 *
 * Replaces @narumitw/pi-firecrawl (fetch) and @parallel-web/pi-extension
 * (search) with a single extension that owns both tool names, so the
 * vocabulary and descriptions are controlled here.
 *
 * Env (read at tool execution time, never in this file):
 *   FIRECRAWL_API_URL      optional, default http://127.0.0.1:3002/v1
 *   FIRECRAWL_API_KEY      required for web_fetch (always sent as Bearer)
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
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIRECRAWL_DEFAULT_URL = "http://127.0.0.1:3002/v1";
const MAX_URLS = 20;
const FETCH_CONCURRENCY = 3;

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

export default function piWebTools(pi: ExtensionAPI) {
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
    async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
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
              out[i].error =
                `HTTP ${res.status}` + (body?.error ? `: ${String(body.error).slice(0, 200)}` : "");
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
