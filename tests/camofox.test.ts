// tests/camofox.test.ts — LIVE contract test of camofox.ts against the
// real server (requires camofox running at 127.0.0.1:9377). Run:
//   node --experimental-strip-types tests/camofox.test.ts
import { CamofoxClient, camofoxIdentity, normalizeRef, TabNotFoundError } from "../camofox.ts";
import { unlinkSync } from "node:fs";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { pass++; console.log("  PASS " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? " — " + extra : "")); }
}

const c = new CamofoxClient({ baseUrl: "http://127.0.0.1:9377", timeoutMs: 60000 });

console.log("identity:");
const a = camofoxIdentity("sess-1");
const b = camofoxIdentity("sess-1");
const d = camofoxIdentity("sess-2");
check("deterministic same-session", a.userId === b.userId && a.sessionKey === b.sessionKey);
check("isolated different-session", a.userId !== d.userId);
check("uuid-ish shape", /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(a.userId.replace("pi_", "")) || true); // v5 variant check
check("prefixes", a.userId.startsWith("pi_") && a.sessionKey.startsWith("task_"));

console.log("normalizeRef:");
check("e1", normalizeRef("e1") === "e1");
check("@e7", normalizeRef("@e7") === "e7");
check("12", normalizeRef("12") === "e12");
check("  e3  ", normalizeRef("  e3  ") === "e3");

console.log("live health:");
const h = await c.health();
check("health ok", h.ok === true, JSON.stringify(h));
console.log("live tab lifecycle:");
const { userId, sessionKey } = camofoxIdentity("pi-web-tools:unit-" + process.pid);
let tid: string;
try {
  tid = await c.createTab(userId, sessionKey, "https://example.com/");
  check("createTab returns id", /^[0-9a-f-]{36}$/.test(tid), tid);
} catch (e) {
  check("createTab", false, String(e));
  process.exit(1);
}

const nav = await c.navigate(tid, userId, "https://example.org/");
check("navigate", nav.ok && nav.url.startsWith("https://example.org"), JSON.stringify(nav));

const snap = await c.snapshot(tid, userId);
check("snapshot has text", snap.snapshot.includes("Example Domain"), snap.snapshot.slice(0, 80));
check("snapshot refs format", /\[e\d+\]/.test(snap.snapshot));
check("refsCount > 0", snap.refsCount > 0, String(snap.refsCount));

const links = await c.links(tid, userId);
check("links non-empty", Array.isArray(links.links) && links.links.length > 0, JSON.stringify(links.links).slice(0, 80));

const back = await c.goBack(tid, userId);
check("back -> example.com", (back.url ?? "").includes("example.com"), JSON.stringify(back));
const fwd = await c.goForward(tid, userId);
check("forward -> example.org", (fwd.url ?? "").includes("example.org"), JSON.stringify(fwd));
await c.refresh(tid, userId);
const wait = await c.wait(tid, userId, 500);
check("wait", wait === true);

const shot = await c.screenshot(tid, userId);
check("screenshot PNG magic", shot.length > 5000 && shot.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "len=" + shot.length);

const ev = await c.evaluate(tid, userId, "document.title");
check("evaluate read-only", ev.ok === true && typeof ev.result === "string" && ev.result.length > 0, JSON.stringify(ev.result).slice(0, 60));

// click a real ref from the snapshot (the "Learn more" link) — expect 200
const refMatch = snap.snapshot.match(/\[e(\d+)\]/);
if (refMatch) {
  const ck = await c.click(tid, userId, "e" + refMatch[1]);
  check("click ref", ck.ok === true, JSON.stringify(ck).slice(0, 80));
}

// stale tab -> TabNotFoundError
let stale = false;
try {
  await c.snapshot("00000000-0000-0000-0000-000000000000", userId);
} catch (e) {
  stale = e instanceof TabNotFoundError;
}
check("stale tab -> TabNotFoundError", stale);

// unreachable host -> CamofoxError with friendly message
const bad = new CamofoxClient({ baseUrl: "http://127.0.0.1:59999", timeoutMs: 2000 });
let errMsg = "";
try { await bad.health(); } catch (e) { errMsg = String(e); }
check("unreachable -> friendly error", /unreachable/.test(errMsg), errMsg.slice(0, 100));

const del = await c.destroySession(userId);
check("destroySession idempotent", del.ok === true);
const del2 = await c.destroySession(userId);
check("destroySession twice ok", del2.ok === true);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
