/**
 * browse.ts — web_browse_* tools: interactive browsing via the local
 * Camofox anti-detection browser (camofox.ts REST client).
 *
 * Architecture mirrors Hermes' browser_camofox backend:
 *   - one Pi session = one Camofox user session (deterministic identity)
 *   - one tab per session, lazily created, transparently recreated if
 *     the server restarted (TabNotFoundError)
 *   - read the page as an accessibility snapshot with [eN] refs, then
 *     act by ref (click/type/press) — Camofox humanizes the input
 *   - evaluate is READ-ONLY by policy; input goes through the
 *     humanized actions
 *   - teardown on session_shutdown / agent_end (idempotent)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CamofoxClient, CamofoxError, TabNotFoundError, camofoxIdentity } from "./camofox.js";

const MAX_SNAPSHOT_LINES = 2000;
const MAX_SNAPSHOT_CHARS = 50_000;

interface BrowseSession {
  userId: string;
  sessionKey: string;
  tabId: string | null;
}

const client = new CamofoxClient();
const sessions = new Map<string, BrowseSession>();

function getSession(ctx: ExtensionContext): BrowseSession {
  const sid = ctx.sessionManager.getSessionId();
  let s = sessions.get(sid);
  if (!s) {
    const id = camofoxIdentity(sid);
    s = { userId: id.userId, sessionKey: id.sessionKey, tabId: null };
    sessions.set(sid, s);
  }
  return s;
}

/** Ensure the session has a live tab; recreate on TabNotFoundError. */
async function ensureTab(s: BrowseSession, url?: string): Promise<string> {
  if (s.tabId) {
    // Probe: a cached tab may be stale after a server restart. We
    // don't pre-probe (extra RTT); the next real call handles 404.
    return s.tabId;
  }
  s.tabId = await client.createTab(s.userId, s.sessionKey, url);
  return s.tabId;
}

/** Run an op; on stale-tab 404, drop the cached tab, recreate, retry once. */
async function withTab<T>(s: BrowseSession, url: string | undefined, op: (tabId: string) => Promise<T>): Promise<T> {
  const tabId = await ensureTab(s, url);
  try {
    return await op(tabId);
  } catch (e) {
    if (!(e instanceof TabNotFoundError)) throw e;
    s.tabId = null;
    const fresh = await ensureTab(s, url);
    return op(fresh);
  }
}

function piError(ctx: ExtensionContext, e: unknown): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } {
  const msg =
    e instanceof CamofoxError
      ? e.message
      : `web_browse error: ${e instanceof Error ? e.message : String(e)}`;
  return {
    content: [{ type: "text", text: "ERROR: " + msg }],
    details: { error: msg, camofox: true },
  };
}

function truncateSnapshot(text: string, ctx: ExtensionContext): string {
  if (text.length <= MAX_SNAPSHOT_CHARS) return text;
  const lines = text.split("\n");
  let out: string[] = [];
  let used = 0;
  for (const l of lines) {
    used += l.length + 1;
    if (used > MAX_SNAPSHOT_CHARS) break;
    out.push(l);
  }
  const file = path.join(os.tmpdir(), `pi-web-browse-snapshot-${Date.now()}.txt`);
  fs.writeFileSync(file, text, "utf8");
  return (
    out.join("\n") +
    `\n\n[snapshot truncated: ${lines.length} lines / ${text.length} chars > ${MAX_SNAPSHOT_LINES} lines / ${MAX_SNAPSHOT_CHARS} chars; full snapshot at ${file}]`
  );
}

export function registerBrowse(pi: ExtensionAPI): void {
  const nav = Type.Object({ url: Type.String({ description: "Absolute URL to load" }) });
  const ref = Type.Object({
    ref: Type.String({ description: 'Element ref from the last snapshot, e.g. "e1" (or "1")' }),
  });
  const typeArgs = Type.Object({
    ref: Type.String({ description: 'Editable-field ref from the last snapshot, e.g. "e2"' }),
    text: Type.String({ description: "Text to type" }),
  });
  const pressArgs = Type.Object({
    key: Type.String({ description: "Key to press: Enter, Tab, Escape, ArrowDown, Backspace, ..." }),
  });
  const scrollArgs = Type.Object({
    direction: Type.Union([Type.Literal("up"), Type.Literal("down")], { description: "Scroll direction" }),
    amount: Type.Optional(Type.Number({ description: "Scroll amount (pixels, optional)" })),
  });
  const snapArgs = Type.Object({});
  const linksArgs = Type.Object({
    limit: Type.Optional(Type.Number({ description: "Max links to return (default 50)" })),
  });
  const evalArgs = Type.Object({
    expression: Type.String({ description: "READ-ONLY JavaScript to evaluate and return (no input simulation)" }),
  });
  const empty = Type.Object({});

  // ---- navigate ----
  pi.registerTool({
    name: "web_browse_navigate",
    label: "Browse: navigate",
    description:
      "Load a URL in the session's anti-detection browser (Camofox). Use for interactive browsing; " +
      "call web_browse_snapshot afterwards to read the page and get element refs.",
    parameters: nav,
    promptSnippet: "web_browse_navigate: load a URL in the browser (interactive)",
    promptGuidelines: [
      "For interactive page exploration (logins, forms, multi-step flows) use the web_browse_* tools: web_browse_navigate, then web_browse_snapshot to read the page, then act by ref (web_browse_click/type/press).",
      "web_browse_evaluate is for READ-ONLY inspection (getting computed values, checking DOM state) — never use it to click, type, or submit; those must go through the humanized web_browse_click/type/press tools.",
      "Call web_browse_close when browsing is finished for the session.",
    ],
    async execute(_toolCallId, params: Static<typeof nav>, _signal, _onUpdate, ctx) {
      const s = getSession(ctx);
      try {
        const tabId = await ensureTab(s);
        const res = await client.navigate(tabId, s.userId, params.url);
        await client.wait(tabId, s.userId, 2000).catch(() => false);
        return {
          content: [{ type: "text", text: `Navigated to ${res.url}\nCall web_browse_snapshot to read the page and get element refs.` }],
          details: { url: res.url, tabId },
        };
      } catch (e) {
        return piError(ctx, e);
      }
    },
  });

  // ---- snapshot ----
  pi.registerTool({
    name: "web_browse_snapshot",
    label: "Browse: snapshot",
    description:
      "Read the current page as an accessibility tree. Interactive elements carry [eN] refs " +
      "(e1, e2, ...) — use those refs with web_browse_click / web_browse_type.",
    parameters: snapArgs,
    promptSnippet: "web_browse_snapshot: read the page (accessibility tree with [eN] refs)",
    async execute(_toolCallId, _params: Static<typeof snapArgs>, _signal, _onUpdate, ctx) {
      const s = getSession(ctx);
      try {
        const tabId = await ensureTab(s);
        const snap = await client.snapshot(tabId, s.userId);
        const text =
          `URL: ${snap.url}\nRefs: ${snap.refsCount}\n\n` +
          truncateSnapshot(snap.snapshot, ctx) +
          (snap.truncated ? `\n\n[server-side truncation: totalChars=${snap.totalChars}]` : "");
        return { content: [{ type: "text", text }], details: { url: snap.url, refsCount: snap.refsCount, truncated: snap.truncated } };
      } catch (e) {
        return piError(ctx, e);
      }
    },
  });

  // ---- click ----
  pi.registerTool({
    name: "web_browse_click",
    label: "Browse: click",
    description: "Click an element by its ref (from web_browse_snapshot). Humanized mouse movement.",
    parameters: ref,
    promptSnippet: "web_browse_click: click an element by ref",
    async execute(_toolCallId, params: Static<typeof ref>, _signal, _onUpdate, ctx) {
      const s = getSession(ctx);
      try {
        const tabId = await ensureTab(s);
        const res = await client.click(tabId, s.userId, params.ref);
        await client.wait(tabId, s.userId, 1500).catch(() => false);
        return {
          content: [{ type: "text", text: `Clicked ${params.ref} → ${res.url}\nCall web_browse_snapshot to see the result.` }],
          details: { ref: params.ref, url: res.url },
        };
      } catch (e) {
        return piError(ctx, e);
      }
    },
  });

  // ---- type ----
  pi.registerTool({
    name: "web_browse_type",
    label: "Browse: type",
    description: "Type text into an editable field by its ref (from web_browse_snapshot).",
    parameters: typeArgs,
    promptSnippet: "web_browse_type: type text into a field by ref",
    async execute(_toolCallId, params: Static<typeof typeArgs>, _signal, _onUpdate, ctx) {
      const s = getSession(ctx);
      try {
        const tabId = await ensureTab(s);
        await client.typeText(tabId, s.userId, params.ref, params.text);
        return {
          content: [{ type: "text", text: `Typed ${JSON.stringify(params.text)} into ${params.ref}.\nCall web_browse_snapshot to verify (or web_browse_press "Enter" to submit).` }],
          details: { ref: params.ref },
        };
      } catch (e) {
        return piError(ctx, e);
      }
    },
  });

  // ---- press ----
  pi.registerTool({
    name: "web_browse_press",
    label: "Browse: press key",
    description: "Press a keyboard key (Enter, Tab, Escape, ArrowDown, ...) in the current page.",
    parameters: pressArgs,
    promptSnippet: "web_browse_press: press a keyboard key",
    async execute(_toolCallId, params: Static<typeof pressArgs>, _signal, _onUpdate, ctx) {
      const s = getSession(ctx);
      try {
        const tabId = await ensureTab(s);
        await client.press(tabId, s.userId, params.key);
        await client.wait(tabId, s.userId, 800).catch(() => false);
        return { content: [{ type: "text", text: `Pressed ${params.key}.` }], details: { key: params.key } };
      } catch (e) {
        return piError(ctx, e);
      }
    },
  });

  // ---- scroll ----
  pi.registerTool({
    name: "web_browse_scroll",
    label: "Browse: scroll",
    description: "Scroll the current page up or down.",
    parameters: scrollArgs,
    promptSnippet: "web_browse_scroll: scroll the page",
    async execute(_toolCallId, params: Static<typeof scrollArgs>, _signal, _onUpdate, ctx) {
      const s = getSession(ctx);
      try {
        const tabId = await ensureTab(s);
        await client.scroll(tabId, s.userId, params.direction, params.amount);
        await client.wait(tabId, s.userId, 500).catch(() => false);
        return { content: [{ type: "text", text: `Scrolled ${params.direction}. Call web_browse_snapshot to read new content.` }], details: { direction: params.direction } };
      } catch (e) {
        return piError(ctx, e);
      }
    },
  });

  // ---- history / refresh ----
  const hist = (name: string, label: string, desc: string, snippet: string, fn: (t: string, u: string) => Promise<{ ok: boolean; url?: string }>) =>
    pi.registerTool({
      name,
      label,
      description: desc,
      parameters: empty,
      promptSnippet: snippet,
      async execute(_toolCallId, _p: Static<typeof empty>, _s, _o, ctx) {
        const s = getSession(ctx);
        try {
          const tabId = await ensureTab(s);
          const res = await fn(tabId, s.userId);
          return { content: [{ type: "text", text: res.url ? `→ ${res.url}` : "OK." }], details: res as Record<string, unknown> };
        } catch (e) {
          return piError(ctx, e);
        }
      },
    });
  hist("web_browse_back", "Browse: back", "Go back in browser history.", "web_browse_back: go back in history", (t, u) => client.goBack(t, u));
  hist("web_browse_forward", "Browse: forward", "Go forward in browser history.", "web_browse_forward: go forward in history", (t, u) => client.goForward(t, u));
  hist("web_browse_refresh", "Browse: refresh", "Reload the current page.", "web_browse_refresh: reload the page", (t, u) => client.refresh(t, u));

  // ---- links ----
  pi.registerTool({
    name: "web_browse_links",
    label: "Browse: links",
    description: "List the links on the current page (url + text).",
    parameters: linksArgs,
    promptSnippet: "web_browse_links: list page links",
    async execute(_toolCallId, params: Static<typeof linksArgs>, _signal, _onUpdate, ctx) {
      const s = getSession(ctx);
      try {
        const tabId = await ensureTab(s);
        const res = await client.links(tabId, s.userId);
        const limit = params.limit ?? 50;
        const shown = res.links.slice(0, limit);
        const body = shown.map((l) => `- ${l.url}${l.text ? ` — ${l.text}` : ""}`).join("\n") +
          (res.links.length > shown.length ? `\n…and ${res.links.length - shown.length} more (re-call with limit=${res.links.length})` : "");
        return { content: [{ type: "text", text: body || "No links found." }], details: { count: res.links.length } };
      } catch (e) {
        return piError(ctx, e);
      }
    },
  });

  // ---- screenshot ----
  pi.registerTool({
    name: "web_browse_screenshot",
    label: "Browse: screenshot",
    description: "Capture the current page as a PNG. Returns the file path (inspect it with a vision tool or read it).",
    parameters: empty,
    promptSnippet: "web_browse_screenshot: capture the page as a PNG (returns a file path)",
    async execute(_toolCallId, _p: Static<typeof empty>, _s, _o, ctx) {
      const s = getSession(ctx);
      try {
        const tabId = await ensureTab(s);
        const png = await client.screenshot(tabId, s.userId);
        const file = path.join(os.tmpdir(), `pi-web-browse-shot-${Date.now()}.png`);
        fs.writeFileSync(file, png);
        return {
          content: [{ type: "text", text: `Screenshot saved to ${file} (${png.length} bytes).` }],
          details: { file, bytes: png.length },
        };
      } catch (e) {
        return piError(ctx, e);
      }
    },
  });

  // ---- evaluate (read-only by policy) ----
  pi.registerTool({
    name: "web_browse_evaluate",
    label: "Browse: evaluate JS (read-only)",
    description:
      "Evaluate READ-ONLY JavaScript in the page and return the result (e.g. document.title, " +
      "computed values, DOM queries). Do NOT use it to click/type/submit — use web_browse_click/" +
      "web_browse_type/web_browse_press for input.",
    parameters: evalArgs,
    promptSnippet: "web_browse_evaluate: run read-only JS in the page",
    async execute(_toolCallId, params: Static<typeof evalArgs>, _signal, _onUpdate, ctx) {
      const s = getSession(ctx);
      try {
        const tabId = await ensureTab(s);
        const res = await client.evaluate(tabId, s.userId, params.expression);
        const val = res.result;
        const text = typeof val === "string" ? val : JSON.stringify(val);
        return { content: [{ type: "text", text: text.slice(0, 20_000) }], details: { result: val } };
      } catch (e) {
        return piError(ctx, e);
      }
    },
  });

  // ---- close ----
  pi.registerTool({
    name: "web_browse_close",
    label: "Browse: close",
    description: "Close the session's browser session (tabs + cookies) on the Camofox server. Idempotent.",
    parameters: empty,
    promptSnippet: "web_browse_close: tear down the browser session",
    async execute(_toolCallId, _p: Static<typeof empty>, _s, _o, ctx) {
      const s = getSession(ctx);
      try {
        const res = await client.destroySession(s.userId);
        sessions.delete(ctx.sessionManager.getSessionId());
        s.tabId = null;
        return { content: [{ type: "text", text: "Browser session closed." }], details: res as Record<string, unknown> };
      } catch (e) {
        return piError(ctx, e);
      }
    },
  });

  // ---- lifecycle: teardown on session end (idempotent) ----
  const teardown = () => {
    for (const s of sessions.values()) {
      client.destroySession(s.userId).catch(() => {});
    }
    sessions.clear();
  };
  pi.on("session_shutdown", teardown);
  pi.on("agent_end", teardown);
}
