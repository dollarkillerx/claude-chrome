// Systematic tests: auth & transport security, URL policy, upload policy, session isolation,
// lifecycle / failure recovery, concurrency & performance, and functional edge cases.
//   CHROME_PATH=... node test/system.e2e.mjs [results.json]
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { cdpCommand, createRecorder, percentile, refOf, sleep, startEnv } from "./harness.mjs";

const outFile = process.argv[2];
const rec = createRecorder();
const { check, info, section } = rec;
const env = await startEnv();
const scratch = mkdtempSync(join(tmpdir(), "claude-chrome-sys-files-"));
const json = (r) => {
  try {
    return JSON.parse(r.text);
  } catch {
    return null;
  }
};

/** Raw WebSocket probe against the hub: returns {code, reason, messages}. */
function probe({ hello, origin, headers, sendRaw, waitMs = 7000 } = {}) {
  return new Promise((resolve) => {
    const messages = [];
    const ws = new WebSocket(`ws://127.0.0.1:${env.port}`, { origin, headers });
    const timer = setTimeout(() => {
      ws.terminate();
      resolve({ code: "timeout", messages });
    }, waitMs);
    ws.on("open", () => {
      if (sendRaw !== undefined) ws.send(sendRaw);
      else if (hello) ws.send(JSON.stringify(hello));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      messages.push(msg);
      if (msg.type === "welcome" && hello?.then) ws.send(JSON.stringify(hello.then));
      if (msg.type === "response") {
        clearTimeout(timer);
        ws.close();
        resolve({ code: "response", messages });
      }
    });
    ws.on("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString(), messages });
    });
    ws.on("error", () => {});
  });
}

const PAGE = `<!doctype html><title>Sys Page</title><main>
<h1>System test</h1>
<button id="b" onclick="log('click')" ondblclick="log('dblclick')" oncontextmenu="event.preventDefault(); log('contextmenu')" onmouseover="log('mouseover')">Target</button>
<input id="t" aria-label="Text field"><input id="u" aria-label="Second field">
<p id="log"></p></main>
<script>window.events=[]; function log(e){ window.events.push(e); document.getElementById('log').textContent = window.events.join(','); }
console.log('boot-info'); console.error('boot-error');</script>`;

try {
  const A = await env.connectClient("session-a");
  await env.pair();
  check("extension pairs and connects", await env.waitConnected(A.call));

  // ---------------------------------------------------------------------------
  section("Transport & authentication");
  const extOrigin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  let p = await probe({ hello: { type: "hello", role: "extension", token: "wrong", protocol: 2 }, origin: extOrigin });
  check("wrong token rejected (4001)", p.code === 4001, JSON.stringify(p));
  p = await probe({ origin: extOrigin });
  check("no hello within 5s → closed (4001)", p.code === 4001, JSON.stringify(p));
  p = await probe({ sendRaw: "{not json", origin: extOrigin });
  check("malformed hello rejected", p.code === 4001, JSON.stringify(p));
  p = await probe({ hello: { type: "hello", role: "extension", token: env.token, protocol: 2 }, origin: "https://evil.example" });
  check("extension role from web origin rejected", p.code === 4001, JSON.stringify(p));
  p = await probe({ hello: { type: "hello", role: "extension", token: env.token, protocol: 2 } });
  check("extension role without Origin rejected", p.code === 4001, JSON.stringify(p));
  p = await probe({
    hello: { type: "hello", role: "peer", token: env.token, protocol: 2, session: "probe" },
    headers: { Host: `evil.example:${env.port}` },
  });
  check("non-loopback Host header rejected (DNS rebinding)", p.code === 4001, JSON.stringify(p));
  p = await probe({ hello: { type: "hello", role: "peer", token: env.token, protocol: 2, session: "probe" }, origin: "http://127.0.0.1" });
  check("peer with an Origin header rejected", p.code === 4001, JSON.stringify(p));
  p = await probe({ hello: { type: "hello", role: "admin", token: env.token, protocol: 2 } });
  check("unknown role rejected", p.code === 4001, JSON.stringify(p));
  p = await probe({
    hello: {
      type: "hello",
      role: "peer",
      token: env.token,
      protocol: 2,
      session: "probe-2",
      then: { type: "request", id: 1, method: "rm_rf", params: {}, session: "x" },
    },
  });
  check(
    "peer: unknown method → BAD_REQUEST",
    p.messages.some((m) => m.type === "response" && m.error?.code === "BAD_REQUEST"),
    JSON.stringify(p),
  );
  p = await probe({ hello: { type: "hello", role: "peer", token: env.token, protocol: 2 } });
  check("peer hello without a session rejected", p.code === 4001, JSON.stringify(p));
  p = await probe({ hello: { type: "hello", role: "peer", token: env.token, protocol: 1, session: "old" } });
  check("outdated protocol version rejected with a clear reason", p.code === 4001 && /protocol/.test(p.reason), JSON.stringify(p));
  const hubSession = (await A.call("status")).text; // keep A's session busy-free; just a liveness ping
  p = await probe({
    hello: {
      type: "hello",
      role: "peer",
      token: env.token,
      protocol: 2,
      session: "impersonator",
      then: { type: "request", id: 1, method: "status", params: {}, session: "someone-else" },
    },
  });
  const probeStatus = p.messages.find((m) => m.type === "response")?.result;
  check(
    "peer can't impersonate another session (request.session ignored)",
    probeStatus && probeStatus.session && !hubSession.includes(`"session": "${probeStatus.session}"`),
    JSON.stringify(probeStatus),
  );
  const httpRes = await fetch(`http://127.0.0.1:${env.port}/`).then((r) => r.status);
  check("plain HTTP request gets 426", httpRes === 426, httpRes);
  check("extension still connected after hostile probes", await env.waitConnected(A.call, 3000));

  // ---------------------------------------------------------------------------
  section("URL policy");
  const pageUrl = env.route("/", PAGE);
  let r = await A.call("tabs_create", { url: pageUrl });
  check("tabs_create on test page", !r.isError, r.text);
  for (const url of ["javascript:alert(1)", "chrome://settings", "view-source:" + pageUrl, "chrome-extension://abc/x.html", "devtools://devtools/bundled/inspector.html"]) {
    r = await A.call("navigate", { url });
    check(`blocked: ${url.split(":")[0]}:`, r.isError && r.text.includes("BLOCKED_BY_POLICY"), r.text);
  }
  r = await A.call("tabs_create", { url: "chrome://version" });
  check("tabs_create refuses chrome:// URL", r.isError && r.text.includes("BLOCKED_BY_POLICY"), r.text);

  await env.extEval(`chrome.storage.local.set({ blockedHosts: ["localhost"] })`);
  await sleep(1500); // settings change triggers a reconnect
  await env.waitConnected(A.call);
  const localhostUrl = pageUrl.replace("127.0.0.1", "localhost");
  r = await A.call("navigate", { url: localhostUrl });
  check("user blocklist blocks host", r.isError && r.text.includes("BLOCKED_BY_POLICY"), r.text);
  r = await A.call("navigate", { url: localhostUrl.replace("localhost", "sub.localhost") });
  check("user blocklist covers subdomains", r.isError && r.text.includes("BLOCKED_BY_POLICY"), r.text);
  const redir = env.redirect("/redir", localhostUrl);
  r = await A.call("navigate", { url: redir });
  check("redirect into blocked host is refused", r.isError && r.text.includes("BLOCKED_BY_POLICY"), r.text);
  r = await A.call("eval_js", { code: "1+1" });
  check("tab left on blocked host stays unusable", r.isError && r.text.includes("BLOCKED_BY_POLICY"), r.text);
  r = await A.call("navigate", { url: pageUrl });
  check("…but navigating away from it is possible", !r.isError, r.text);
  await env.extEval(`chrome.storage.local.set({ blockedHosts: [] })`);
  await sleep(1500);
  await env.waitConnected(A.call);

  const secretFile = join(scratch, "secret.txt");
  writeFileSync(secretFile, "TOP-SECRET-CONTENT");
  r = await A.call("navigate", { url: "file://" + secretFile });
  const fileNav = r;
  r = await A.call("get_page_text");
  check(
    "file:// pages cannot be read (would bypass the upload denylist)",
    fileNav.isError || r.isError || !r.text.includes("TOP-SECRET-CONTENT"),
    `navigate: ${fileNav.text.slice(0, 120)} | text: ${r.text.slice(0, 160)}`,
  );
  await A.call("navigate", { url: pageUrl });

  r = await A.call("navigate", { url: "http://127.0.0.1:1/" });
  info("navigate to a refused port", r.text.slice(0, 200));
  r = await A.call("eval_js", { code: "1+1" });
  check("tab still usable after a failed navigation (error page)", !r.isError || !r.text.includes("BLOCKED"), r.text);
  r = await A.call("navigate", { url: pageUrl });
  check("can navigate away from the error page", !r.isError, r.text);

  // ---------------------------------------------------------------------------
  section("Upload policy");
  const fakeHome = join(scratch, "home");
  mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
  writeFileSync(join(fakeHome, ".ssh", "config"), "Host *");
  symlinkSync(join(fakeHome, ".ssh"), join(fakeHome, "innocent-dir"));
  writeFileSync(join(fakeHome, "ok.txt"), "fine");
  const U = await env.connectClient("upload-session", { HOME: fakeHome });
  const uploadUrl = env.route("/upload", `<!doctype html><title>Up</title><input type=file id=f aria-label="Upload" multiple><p id=o></p>
<script>f.onchange=()=>o.textContent=[...f.files].map(x=>x.name).join(',')</script>`);
  await U.call("tabs_create", { url: uploadUrl });
  r = await U.call("file_upload", { paths: [join(fakeHome, "ok.txt")] });
  check("normal file uploads", !r.isError, r.text);
  r = await U.call("file_upload", { paths: [join(fakeHome, ".ssh", "config")] });
  check("~/.ssh blocked", r.isError && r.text.includes("BLOCKED_BY_POLICY"), r.text);
  r = await U.call("file_upload", { paths: [join(fakeHome, ".SSH", "config")] });
  check("~/.SSH (case variant on case-insensitive FS) blocked", r.isError, r.text);
  r = await U.call("file_upload", { paths: [join(fakeHome, "innocent-dir", "config")] });
  check("symlinked directory into ~/.ssh blocked", r.isError && r.text.includes("BLOCKED_BY_POLICY"), r.text);
  r = await U.call("file_upload", { paths: [join(env.home, "token")] });
  check("token file in CLAUDE_CHROME_HOME blocked", r.isError, r.text);
  r = await U.call("file_upload", { paths: ["~/ok.txt"] });
  check("~ expansion works", !r.isError, r.text);
  const R = await env.connectClient("restricted-session", { CLAUDE_CHROME_UPLOAD_DIRS: join(scratch, "only-here") });
  mkdirSync(join(scratch, "only-here"));
  await R.call("tabs_create", { url: uploadUrl });
  r = await R.call("file_upload", { paths: [join(fakeHome, "ok.txt")] });
  check("CLAUDE_CHROME_UPLOAD_DIRS restricts uploads", r.isError && r.text.includes("outside"), r.text);
  await R.client.close();
  await U.client.close();

  // ---------------------------------------------------------------------------
  section("Session isolation");
  const B = await env.connectClient("session-b");
  const browserWs = await env.browserWs();
  const { targetId } = await cdpCommand(browserWs, "Target.createTarget", { url: pageUrl + "?user-tab" });
  await sleep(800);
  const userTab = json(await A.call("tabs_list")).find((t) => t.url?.includes("user-tab"));
  check("user-opened tab is unowned", userTab && userTab.owner === null, JSON.stringify(userTab));
  r = await A.call("tabs_select", { tabId: userTab.tabId });
  check("session A can select the user's tab", !r.isError, r.text);
  r = await B.call("tabs_select", { tabId: userTab.tabId });
  check("session B cannot also grab the tab A selected", r.isError && r.text.includes("TAB_IN_USE"), r.text);
  r = await B.call("eval_js", { code: "1", tabId: userTab.tabId });
  check("session B cannot drive it by explicit tabId either", r.isError && r.text.includes("TAB_IN_USE"), r.text);
  r = await B.call("tabs_select", { tabId: userTab.tabId, takeOver: true });
  check("takeOver transfers the tab to B", !r.isError, r.text);
  r = await A.call("eval_js", { code: "1" });
  check("A lost its current tab after takeOver", r.isError && /NO_TAB_SELECTED|TAB_IN_USE/.test(r.text), r.text);
  r = await A.call("tabs_close", { tabId: userTab.tabId });
  check("A cannot close B's tab", r.isError && r.text.includes("TAB_IN_USE"), r.text);
  await cdpCommand(browserWs, "Target.closeTarget", { targetId }).catch(() => {});
  await A.call("tabs_create", { url: pageUrl });

  // ---------------------------------------------------------------------------
  section("Concurrency & performance");
  await B.call("tabs_create", { url: pageUrl + "?b" });
  const latencies = [];
  const parallel = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      (i % 2 ? B : A).call("eval_js", { code: `await new Promise(r => setTimeout(r, ${i % 7} * 10)); ${i} * 2` }).then((res) => {
        latencies.push(res.ms);
        return res.text.trim() === String(i * 2);
      }),
    ),
  );
  check("100 parallel eval_js across 2 sessions all correct", parallel.every(Boolean), parallel.filter((x) => !x).length + " wrong");
  info("parallel eval_js latency", `p50 ${percentile(latencies, 50).toFixed(0)} ms, p95 ${percentile(latencies, 95).toFixed(0)} ms`, {
    metric: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
  });
  for (const [tool, args] of [["screenshot", {}], ["read_page", {}], ["find", { query: "Target" }], ["get_page_text", {}], ["tabs_list", {}]]) {
    const times = [];
    for (let i = 0; i < 8; i++) times.push((await A.call(tool, args)).ms);
    info(`${tool} latency`, `median ${percentile(times, 50).toFixed(0)} ms`, { metric: { tool, median: percentile(times, 50) } });
  }
  const bigUrl = env.route(
    "/big",
    `<!doctype html><title>Big</title>${Array.from({ length: 4000 }, (_, i) => `<button>Button ${i}</button>`).join("")}`,
  );
  await A.call("navigate", { url: bigUrl });
  r = await A.call("read_page");
  check("read_page on 4000-element page truncates", r.text.includes("[truncated"), r.text.slice(-200));
  info("read_page on 4000 elements", `${r.ms.toFixed(0)} ms, ${r.text.length} chars`);
  r = await A.call("find", { query: "Button 3999" });
  check("find locates element deep in a big page", /Button 3999.*ref_/.test(r.text), r.text.slice(0, 200));
  r = await A.call("read_page", { filter: "interactive", maxChars: 2000 });
  check("maxChars honored", r.text.length < 2300, r.text.length);

  // ---------------------------------------------------------------------------
  section("Functional edge cases");
  await A.call("navigate", { url: pageUrl });
  const target = refOf((await A.call("find", { query: "Target" })).text, /button/);
  await A.call("hover", { ref: target });
  await A.call("click", { ref: target, button: "right" });
  await A.call("click", { ref: target, clickCount: 2 });
  r = await A.call("eval_js", { code: "window.events.join(',')" });
  check("hover / right-click / double-click fire DOM events", /mouseover/.test(r.text) && /contextmenu/.test(r.text) && /dblclick/.test(r.text), r.text);
  const field = refOf((await A.call("find", { query: "Text field" })).text, /textbox/);
  await A.call("type", { ref: field, text: "你好🌏 é" });
  r = await A.call("eval_js", { code: "document.getElementById('t').value" });
  check("type handles CJK / emoji / accents", r.text.includes("你好🌏 é"), r.text);
  await A.call("key", { keys: "shift+a Tab" });
  r = await A.call("eval_js", { code: "[document.getElementById('t').value, document.activeElement.id]" });
  check("shift+a types 'A' and Tab moves focus", r.text.includes("你好🌏 éA") && r.text.includes('"u"'), r.text);
  r = await A.call("key", { keys: "hyper+x" });
  check("unknown modifier → BAD_REQUEST", r.isError && r.text.includes("BAD_REQUEST"), r.text);
  r = await A.call("click", {});
  check("click without ref/coordinate → BAD_REQUEST", r.isError && r.text.includes("BAD_REQUEST"), r.text);
  r = await A.call("console_logs", { onlyErrors: true });
  info("console_logs onlyErrors", r.text.slice(0, 120));
  await A.call("eval_js", { code: "console.error('needle-err'); console.log('needle-log')" });
  r = await A.call("console_logs", { pattern: "needle", clear: true });
  check("console_logs pattern filter", r.text.includes("needle-err") && r.text.includes("needle-log"), r.text);
  r = await A.call("console_logs", { pattern: "needle" });
  check("console_logs clear empties buffer", !r.text.includes("needle-err"), r.text);
  const iframeUrl = env.route("/iframe", `<!doctype html><title>Frames</title><iframe srcdoc="<button>Inside frame</button>"></iframe>`);
  await A.call("navigate", { url: iframeUrl });
  await sleep(300);
  r = await A.call("find", { query: "Inside frame" });
  info("find inside iframe (known limitation)", r.text.slice(0, 160));
  await A.call("navigate", { url: pageUrl });
  await A.call("navigate", { url: iframeUrl });
  await A.call("navigate", { url: "back" });
  r = await A.call("navigate", { url: "forward" });
  check("history back/forward", r.text.includes("Frames"), r.text);
  r = await A.call("navigate", { url: pageUrl + "#section" });
  check("same-document (hash) navigation returns promptly", !r.isError && r.ms < 5000, `${r.ms.toFixed(0)} ms ${r.text}`);

  // ---------------------------------------------------------------------------
  section("Lifecycle & failure recovery");
  r = await A.call("eval_js", { code: "await new Promise(() => {})" });
  check("hanging eval_js times out with TIMEOUT", r.isError && r.text.includes("TIMEOUT"), `${r.ms.toFixed(0)} ms ${r.text}`);
  r = await A.call("eval_js", { code: "'alive'" });
  check("bridge still usable after a timeout", r.text.includes("alive"), r.text);

  const staleRef = refOf((await A.call("find", { query: "Target" })).text, /button/);
  const worker = await env.extensionWorker();
  const started = Date.now();
  const closed = await cdpCommand(browserWs, "Target.closeTarget", { targetId: worker.id }).then(
    () => true,
    (e) => e.message,
  );
  if (closed === true) {
    // The hub notices the dropped socket; the worker comes back via its alarm or the next event.
    let recovered = false;
    for (let i = 0; i < 200 && !recovered; i++) {
      await sleep(250);
      r = await A.call("tabs_list");
      recovered = !r.isError;
    }
    check("service worker killed → extension reconnects and serves calls", recovered, r.text.slice(0, 200));
    info("reconnect after service worker kill", `${((Date.now() - started) / 1000).toFixed(1)} s`);
    r = await A.call("eval_js", { code: "document.title" });
    check("session's current tab survives a service worker restart", r.text.includes("Sys Page"), r.text);
    r = await A.call("click", { ref: staleRef });
    check("refs from before the restart report REF_NOT_FOUND", r.isError && r.text.includes("REF_NOT_FOUND"), r.text);
  } else {
    info("service worker kill", `skipped: ${closed}`);
  }

  await env.extEval(`chrome.storage.local.set({ paused: true })`);
  await sleep(1000);
  r = await A.call("status");
  check("pause disconnects the extension", json(r)?.extensionConnected === false, r.text);
  await env.extEval(`chrome.storage.local.set({ paused: false })`);
  check("resume reconnects", await env.waitConnected(A.call));

  // Hub crash: A owns the port, B is a peer.
  const statusA = json(await A.call("status"));
  const statusB = json(await B.call("status"));
  check("A is hub, B is peer", statusA.mode === "hub" && statusB.mode === "peer", `${statusA.mode}/${statusB.mode}`);
  const aTab = statusA.currentTabId;
  const crashAt = Date.now();
  process.kill(A.pid, "SIGKILL");
  let promoted = false;
  for (let i = 0; i < 100 && !promoted; i++) {
    await sleep(200);
    const s = json(await B.call("status"));
    promoted = s?.mode === "hub" && s.extensionConnected;
  }
  check("hub crash → peer promoted and extension reconnects", promoted, "");
  info("failover time after hub crash", `${((Date.now() - crashAt) / 1000).toFixed(1)} s`);
  r = await B.call("eval_js", { code: "'b-alive'" });
  check("peer session keeps working after failover", r.text.includes("b-alive"), r.text);
  // Released once the new hub's session announcement grace period (15s) passes.
  const releaseStart = Date.now();
  for (let i = 0; i < 100; i++) {
    r = await B.call("tabs_select", { tabId: aTab });
    if (!r.isError) break;
    await sleep(250);
  }
  check("crashed session's tabs are released (not locked forever)", !r.isError, r.text);
  info("crashed session's tabs released after", `${((Date.now() - releaseStart) / 1000).toFixed(1)} s`);

  // Graceful exit of the (new) hub: does another session see its tabs released?
  const C = await env.connectClient("session-c");
  await C.call("tabs_create", { url: pageUrl + "?c" });
  const bTab = json(await B.call("status")).currentTabId;
  await B.client.close();
  let cOk = false;
  for (let i = 0; i < 60 && !cOk; i++) {
    await sleep(250);
    const res = await C.call("tabs_select", { tabId: bTab });
    cOk = !res.isError;
    r = res;
  }
  check("graceful hub exit releases its tabs to other sessions", cOk, r.text);
} catch (error) {
  check("suite crashed", false, error.stack);
} finally {
  await env.close();
  rmSync(scratch, { recursive: true, force: true });
  const failed = rec.results.filter((x) => !x.ok);
  console.log(`\n${rec.results.filter((x) => !x.info).length - failed.length} passed, ${failed.length} failed`);
  if (outFile) writeFileSync(outFile, JSON.stringify(rec.results, null, 2));
  process.exit(failed.length ? 1 : 0);
}
