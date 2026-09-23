/**
 * camofox.ts — thin client for the local camofox-browser REST API
 * (https://github.com/jo-inc/camofox-browser, v1.14.0 contract).
 *
 * Anti-detection browser (Camoufox/Firefox) driven over HTTP. Every
 * request carries the session's `userId`; the session's `sessionKey` is
 * needed only when creating tabs.
 *
 * Pure module: no Pi imports, so it is unit-testable and deployable
 * anywhere a browser is reachable.
 */
import { createHash } from "node:crypto";

// ---------- Identity ----------

/**
 * Deterministic Camofox identity for a Pi session.
 *
 * Mirrors Hermes' browser_camofox_state.get_camofox_identity():
 * a stable userId + sessionKey derived from the caller's session id via
 * UUIDv5 (SHA-1), so the same Pi session always maps to the same browser
 * session (cookies/logins/JS state persist across tool calls), while
 * different sessions are fully isolated.
 */
export function camofoxIdentity(sessionId: string): {
  userId: string;
  sessionKey: string;
} {
  return {
    userId: "pi_" + uuidv5(sessionId, "user"),
    sessionKey: "task_" + uuidv5(sessionId, "session"),
  };
}

const PI_NAMESPACE = "1b7f6bb8-4a2e-4c1f-9d63-piwebtools01"; // fixed namespace (not RFC uuid.NAMESPACE_URL — our own scope)

/** Synchronous UUIDv5 (SHA-1) — RFC 4122 §4.3. */
function uuidv5(name: string, role: string): string {
  const h = createHash("sha1").update(PI_NAMESPACE + ":" + role + ":" + name).digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5
  h[8] = (h[8] & 0x3f) | 0x80; // variant 10
  const hex = h.subarray(0, 16).toString("hex");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20, 32);
}

// ---------- Errors ----------

export class CamofoxError extends Error {
  readonly status: number | undefined;
  readonly body: string;
  constructor(message: string, status: number | undefined, body: string) {
    super(message);
    this.name = "CamofoxError";
    this.status = status;
    this.body = body;
  }
}

/** Server reported the tab id is unknown (server restart, session gone, …).
 *  Callers should treat this as "recreate the tab", not a hard failure. */
export class TabNotFoundError extends CamofoxError {
  constructor(body: string) {
    super("tab not found", 404, body);
    this.name = "TabNotFoundError";
  }
}

// ---------- Client ----------

export interface CamofoxOptions {
  /** Base URL. Default: env CAMOFOX_URL, else http://127.0.0.1:9377 */
  baseUrl?: string;
  /** Bearer token. Default: env CAMOFOX_API_KEY (empty = no auth). */
  apiKey?: string;
  /** Per-request timeout in ms. Default 120_000 (page loads + humanized
   *  mouse movement can be slow; screenshots are larger). */
  timeoutMs?: number;
}

export interface SnapshotResult {
  url: string;
  /** Accessibility tree; interactive elements carry `[eN]` refs. */
  snapshot: string;
  refsCount: number;
  truncated: boolean;
  totalChars: number;
}

export interface LinkResult {
  url: string;
  text: string;
}

export class CamofoxClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(opts: CamofoxOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.CAMOFOX_URL ?? "http://127.0.0.1:9377").replace(/\/+$/, "");
    this.apiKey = (opts.apiKey ?? process.env.CAMOFOX_API_KEY ?? "").trim();
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  // -- low-level --

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    query?: Record<string, string>,
    expectJson = true,
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = "Bearer " + this.apiKey;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      const msg = e instanceof Error && e.name === "AbortError"
        ? `camofox request timed out after ${this.timeoutMs}ms (${method} ${path})`
        : `camofox unreachable at ${this.baseUrl}: ${e instanceof Error ? e.message : String(e)}`;
      throw new CamofoxError(msg, undefined, "");
    } finally {
      clearTimeout(timer);
    }

    const wantBinary = !expectJson;
    // Read the body once; keep bytes for the binary success path, text otherwise.
    const buf = await resp.arrayBuffer();
    const raw = wantBinary && resp.ok ? "" : new TextDecoder().decode(buf);
    if (!resp.ok) {
      if (resp.status === 404 && /tab not found/i.test(raw)) throw new TabNotFoundError(raw);
      throw new CamofoxError(
        `camofox ${method} ${path} -> ${resp.status}: ${raw.slice(0, 300)}`,
        resp.status,
        raw,
      );
    }
    if (wantBinary) return Buffer.from(buf) as unknown as T;
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new CamofoxError(`camofox ${method} ${path} returned non-JSON: ${raw.slice(0, 200)}`, resp.status, raw);
    }
  }

  // -- session / tab lifecycle --

  health(): Promise<{ ok: boolean }> {
    return this.request("GET", "/health");
  }

  /** Create (or re-create) the session's tab. `url` defaults to about:blank. */
  async createTab(userId: string, sessionKey: string, url?: string): Promise<string> {
    const data = await this.request<{ tabId: string; url: string }>("POST", "/tabs", {
      userId,
      sessionKey,
      ...(url ? { url } : {}),
    });
    return data.tabId;
  }

  /** Destroy the whole user session (all its tabs). Idempotent. */
  destroySession(userId: string): Promise<{ ok: boolean }> {
    return this.request("DELETE", `/sessions/${encodeURIComponent(userId)}`);
  }

  listTabs(): Promise<{ running: boolean; tabs: unknown[] }> {
    return this.request("GET", "/tabs");
  }

  // -- navigation --

  async navigate(tabId: string, userId: string, url: string): Promise<{ ok: boolean; url: string }> {
    const data = await this.request<{ ok: boolean; tabId: string; url: string; refsAvailable?: boolean }>(
      "POST",
      `/tabs/${tabId}/navigate`,
      { userId, url },
    );
    return { ok: data.ok, url: data.url };
  }

  goBack(tabId: string, userId: string): Promise<{ ok: boolean; url?: string }> {
    return this.request("POST", `/tabs/${tabId}/back`, { userId });
  }

  goForward(tabId: string, userId: string): Promise<{ ok: boolean; url?: string }> {
    return this.request("POST", `/tabs/${tabId}/forward`, { userId });
  }

  refresh(tabId: string, userId: string): Promise<{ ok: boolean; url?: string }> {
    return this.request("POST", `/tabs/${tabId}/refresh`, { userId });
  }

  /** Wait for the page to settle (post-navigation). */
  async wait(tabId: string, userId: string, timeoutMs = 1500): Promise<boolean> {
    const data = await this.request<{ ok: boolean; ready?: boolean }>("POST", `/tabs/${tabId}/wait`, {
      userId,
      timeout: timeoutMs,
    });
    return data.ok && (data.ready !== false);
  }

  // -- reading --

  /** Accessibility-tree snapshot. Interactive elements carry `[eN]` refs. */
  async snapshot(tabId: string, userId: string): Promise<SnapshotResult> {
    const data = await this.request<SnapshotResult & Record<string, unknown>>("GET", `/tabs/${tabId}/snapshot`, undefined, { userId });
    return {
      url: data.url ?? "",
      snapshot: data.snapshot ?? "",
      refsCount: data.refsCount ?? 0,
      truncated: data.truncated ?? false,
      totalChars: data.totalChars ?? 0,
    };
  }

  links(tabId: string, userId: string): Promise<{ links: LinkResult[] }> {
    return this.request("GET", `/tabs/${tabId}/links`, undefined, { userId });
  }

  /** Raw PNG bytes. */
  screenshot(tabId: string, userId: string): Promise<Buffer> {
    return this.request<Buffer>("GET", `/tabs/${tabId}/screenshot`, undefined, { userId }, false);
  }

  /**
   * Evaluate JS in the tab. READ-ONLY BY POLICY (Hermes browser-discipline):
   * input-generating actions must use click/type/press, which Camofox
   * humanizes; raw JS mutation bypasses that and gets flagged.
   */
  async evaluate(tabId: string, userId: string, expression: string): Promise<{ ok: boolean; result: unknown }> {
    return this.request("POST", `/tabs/${tabId}/evaluate`, { userId, expression });
  }

  // -- actions (humanized) --

  /** Click an element by ref. Accepts `e1`, `@e1`, `1` — normalized to `eN`. */
  click(tabId: string, userId: string, ref: string): Promise<{ ok: boolean; url: string }> {
    return this.request("POST", `/tabs/${tabId}/click`, { userId, ref: normalizeRef(ref) });
  }

  /** Type text into an editable field by ref. */
  typeText(tabId: string, userId: string, ref: string, text: string): Promise<{ ok: boolean }> {
    return this.request("POST", `/tabs/${tabId}/type`, { userId, ref: normalizeRef(ref), text });
  }

  /** Press a key: `Enter`, `Tab`, `Escape`, `ArrowDown`, … */
  press(tabId: string, userId: string, key: string): Promise<{ ok: boolean }> {
    return this.request("POST", `/tabs/${tabId}/press`, { userId, key });
  }

  /** Scroll. direction: up | down. */
  scroll(tabId: string, userId: string, direction: "up" | "down", amount?: number): Promise<{ ok: boolean }> {
    return this.request("POST", `/tabs/${tabId}/scroll`, {
      userId,
      direction,
      ...(amount !== undefined ? { amount } : {}),
    });
  }
}

/** Normalize a model-supplied ref to the server's `eN` form. */
export function normalizeRef(ref: string): string {
  const r = ref.trim().replace(/^@/, "");
  if (/^\d+$/.test(r)) return "e" + r;
  return r;
}
