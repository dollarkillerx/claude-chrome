// End-to-end test: real Chromium + built extension + built MCP server, driven through an MCP client.
// Requires a Chromium that still honors --load-extension (Chromium / Chrome for Testing, not branded Chrome 137+).
//   CHROME_PATH=/path/to/chrome node test/e2e.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const root = resolve(import.meta.dirname, "../../..");
const extensionDir = join(root, "packages/extension/dist");
const serverEntry = join(root, "packages/server/dist/index.js");
const chromePath = process.env.CHROME_PATH;
if (!chromePath) throw new Error("Set CHROME_PATH to a Chromium / Chrome for Testing binary");

const token = randomBytes(12).toString("hex");
const port = 30000 + Math.floor(Math.random() * 20000);
const home = mkdtempSync(join(tmpdir(), "claude-chrome-e2e-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  →  ${detail}`}`);
  if (!ok) failures++;
}

// --- local test page -------------------------------------------------------
const PAGE = `<!doctype html><title>E2E Page</title>
<main><h1>Test page</h1>
<button id="inc" onclick="window.count=(window.count||0)+1; this.textContent='Clicked '+window.count">Increment</button>
<label>Name <input id="name"></label>
<form onsubmit="event.preventDefault(); document.getElementById('out').textContent='Submitted '+document.getElementById('name').value"><input id="q" aria-label="Query"></form>
<p id="out"></p><div style="height:3000px">tall</div><p>Bottom marker</p></main>
<script>console.log("hello from page"); console.error("page error");</script>`;
const UPLOAD_PAGE = `<!doctype html><title>Upload Page</title>
<label>Documents <input type="file" id="docs" multiple></label>
<input type="file" id="avatar" style="display:none">
<button onclick="document.getElementById('avatar').click()">Choose avatar</button>
<p id="out"></p>
<script>
  const out = document.getElementById("out");
  const show = (el) => el.addEventListener("change", () => {
    out.textContent += el.id + ":" + [...el.files].map((f) => f.name + "/" + f.size).join(",") + " ";
  });
  show(document.getElementById("docs")); show(document.getElementById("avatar"));
</script>`;
const SINGLE_PAGE = `<!doctype html><title>Single Upload</title>
<input type="file" id="only" style="display:none"><p id="out"></p>
<script>document.getElementById("only").addEventListener("change", (e) => {
  document.getElementById("out").textContent = "only:" + e.target.files[0].name;
});</script>`;
const ROUTES = { "/": PAGE, "/upload": UPLOAD_PAGE, "/single": SINGLE_PAGE };
const http = createServer((req, res) =>
  res.writeHead(200, { "content-type": "text/html" }).end(ROUTES[req.url] ?? PAGE),
);
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${http.address().port}/`;

// --- launch Chromium with the extension ----------------------------------------
const profile = join(home, "profile");
const chrome = spawn(
  chromePath,
  [
    `--user-data-dir=${profile}`,
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);

async function devtoolsPort() {
  const file = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    if (existsSync(file)) return Number(readFileSync(file, "utf8").split("\n")[0]);
    await sleep(100);
  }
  throw new Error("Chromium did not start");
}

/** Evaluates an expression in a CDP target and returns the value. */
async function evaluateIn(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.once("open", r));
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  const msg = await new Promise((r) =>
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id === 1) r(m); // skip CDP events
    }),
  );
  ws.close();
  return msg.result?.result?.value;
}

async function configureExtension(cdpPort) {
  // Chromium ships component extensions with service workers too; find ours by manifest name.
  for (let i = 0; i < 100; i++) {
    const targets = await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json());
    for (const target of targets.filter((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"))) {
      if ((await evaluateIn(target, "chrome.runtime.getManifest().name")) !== "Local Chrome for Claude") continue;
      await evaluateIn(target, `chrome.storage.local.set(${JSON.stringify({ token, port })})`);
      return;
    }
    await sleep(100);
  }
  throw new Error("Extension service worker not found");
}

// --- MCP clients (each one = one Claude session = one server process) ------------
async function connectClient(name) {
  const client = new Client({ name, version: "0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env: { ...process.env, CLAUDE_CHROME_TOKEN: token, CLAUDE_CHROME_PORT: String(port), CLAUDE_CHROME_HOME: home },
      stderr: "inherit",
    }),
  );
  const call = async (tool, args = {}) => {
    const res = await client.callTool({ name: tool, arguments: args });
    const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return { ...res, text };
  };
  return { client, call };
}

const { client, call } = await connectClient("e2e-a");
let clientB;

// Files to upload (outside CLAUDE_CHROME_HOME, which is itself off-limits for uploads).
const files = mkdtempSync(join(tmpdir(), "claude-chrome-e2e-files-"));
const fileA = join(files, "a.txt");
const fileB = join(files, "b.txt");
const secret = join(files, ".env");
writeFileSync(fileA, "hello");
writeFileSync(fileB, "world!");
writeFileSync(secret, "TOKEN=1");
const refOf = (text, pattern) => text.split("\n").find((l) => pattern.test(l))?.match(/\[(ref_\d+)\]/)?.[1];

try {
  const tools = await client.listTools();
  check("lists 18 tools", tools.tools.length === 18, tools.tools.length);

  await configureExtension(await devtoolsPort());
  let status;
  for (let i = 0; i < 50; i++) {
    status = JSON.parse((await call("status")).text);
    if (status.extensionConnected) break;
    await sleep(200);
  }
  check("extension connects to hub", status.extensionConnected === true, JSON.stringify(status));
  if (!status.extensionConnected) throw new Error("extension never connected; aborting");

  let r = await call("navigate", { url: pageUrl });
  check("navigate without a tab → NO_TAB_SELECTED", r.isError && r.text.includes("NO_TAB_SELECTED"), r.text);

  r = await call("tabs_create", { url: pageUrl });
  check("tabs_create loads page", !r.isError && r.text.includes("E2E Page"), r.text);

  r = await call("read_page");
  check("read_page shows heading + button", r.text.includes('heading "Test page"') && /button "Increment".*\[ref_\d+\]/.test(r.text), r.text);

  r = await call("find", { query: "increment" });
  const buttonRef = refOf(r.text, /button/);
  check("find returns button ref", Boolean(buttonRef), r.text);

  r = await call("click", { ref: buttonRef });
  r = await call("eval_js", { code: "window.count" });
  check("click by ref fires handler", r.text.trim() === "1", r.text);

  r = await call("find", { query: "Name" });
  const nameRef = refOf(r.text, /textbox/);
  r = await call("type", { ref: nameRef, text: "Claude" });
  r = await call("eval_js", { code: "document.getElementById('name').value" });
  check("type into ref", r.text.includes("Claude"), r.text);

  r = await call("key", { keys: "cmd+a Backspace" });
  r = await call("eval_js", { code: "document.getElementById('name').value" });
  check("key cmd+a Backspace clears input", r.text.trim() === '""', r.text);

  r = await call("find", { query: "Query" });
  await call("type", { ref: refOf(r.text, /textbox/), text: "x" });
  await call("key", { keys: "Enter" });
  r = await call("get_page_text");
  check("Enter submits form / get_page_text", r.text.includes("Submitted"), r.text.slice(0, 300));

  r = await call("screenshot");
  const image = r.content.find((c) => c.type === "image");
  check("screenshot returns image", image && image.data.length > 1000 && image.mimeType === "image/jpeg", r.text);

  r = await call("scroll", { direction: "down", amount: 5 });
  check("scroll moves page", /offset now \(0, [1-9]\d*\)/.test(r.text), r.text);

  r = await call("click", { coordinate: [5, 5] });
  check("click by coordinate", !r.isError, r.text);

  r = await call("eval_js", { code: "await new Promise(r => setTimeout(() => r(6*7), 50))" });
  check("eval_js top-level await", r.text.trim() === "42", r.text);

  r = await call("eval_js", { code: "throw new Error('nope')" });
  check("eval_js exception → JS_EXCEPTION", r.isError && r.text.includes("JS_EXCEPTION"), r.text);

  await call("eval_js", { code: "console.warn('after attach')" });
  r = await call("console_logs");
  check("console_logs captures messages", r.text.includes("after attach"), r.text);

  r = await call("navigate", { url: "chrome://settings" });
  check("chrome:// blocked by policy", r.isError && r.text.includes("BLOCKED_BY_POLICY"), r.text);

  await call("navigate", { url: "about:blank" });
  r = await call("navigate", { url: "back" });
  check("navigate back", r.text.includes("E2E Page"), r.text);

  r = await call("tabs_list");
  const tabs = JSON.parse(r.text);
  check("tabs_list marks Claude tab", tabs.some((t) => t.current && t.owner === "this session"), r.text);

  r = await call("click", { ref: "ref_9999" });
  check("unknown ref → REF_NOT_FOUND", r.isError && r.text.includes("REF_NOT_FOUND"), r.text);

  // --- screenshots: full page and element -------------------------------------
  await call("navigate", { url: pageUrl });
  r = await call("screenshot", { fullPage: true });
  check("full-page screenshot is taller than viewport", /Full page \d+x(\d{4,})/.test(r.text), r.text);
  r = await call("find", { query: "increment" });
  r = await call("screenshot", { ref: refOf(r.text, /button/), format: "png" });
  const elementShot = r.content.find((c) => c.type === "image");
  check("element screenshot", elementShot?.mimeType === "image/png" && r.text.startsWith("Element ref_"), r.text);

  // --- file upload -----------------------------------------------------------
  await call("navigate", { url: pageUrl + "upload" });
  r = await call("find", { query: "Documents" });
  const docsRef = refOf(r.text, /button|textbox|Documents/);
  r = await call("file_upload", { ref: docsRef, paths: [fileA, fileB] });
  check("upload 2 files into <input multiple> by ref", !r.isError, r.text);
  r = await call("find", { query: "Choose avatar" });
  r = await call("file_upload", { ref: refOf(r.text, /button/), paths: [fileA] });
  check("upload via button that opens a file chooser", !r.isError && r.text.includes("chooser"), r.text);
  r = await call("eval_js", { code: "document.getElementById('out').textContent" });
  check(
    "page received change events with the right files",
    r.text.includes("docs:a.txt/5,b.txt/6") && r.text.includes("avatar:a.txt/5"),
    r.text,
  );
  r = await call("file_upload", { paths: [fileA] });
  check("no ref with 2 file inputs → asks for ref", r.isError && r.text.includes("pass ref"), r.text);
  r = await call("file_upload", { ref: docsRef, paths: [secret] });
  check(".env upload blocked", r.isError && r.text.includes("BLOCKED_BY_POLICY"), r.text);
  r = await call("file_upload", { ref: docsRef, paths: ["relative.txt"] });
  check("relative path rejected", r.isError && r.text.includes("absolute"), r.text);
  await call("navigate", { url: pageUrl + "single" });
  r = await call("file_upload", { paths: [fileB] });
  r = await call("eval_js", { code: "document.getElementById('out').textContent" });
  check("no ref → page's only (hidden) file input", r.text.includes("only:b.txt"), r.text);

  // --- two concurrent Claude sessions ----------------------------------------
  await call("navigate", { url: pageUrl });
  const statusA = JSON.parse((await call("status")).text);
  clientB = await connectClient("e2e-b");
  const callB = clientB.call;
  const statusB0 = JSON.parse((await callB("status")).text);
  check("second session becomes a peer", statusB0.mode === "peer", JSON.stringify(statusB0));

  r = await callB("tabs_create", { url: pageUrl + "upload" });
  const tabB = JSON.parse(r.text).tabId;
  const statusB = JSON.parse((await callB("status")).text);
  check(
    "sessions get distinct labels and windows",
    statusA.session !== statusB.session && statusA.windowId !== statusB.windowId,
    `${JSON.stringify(statusA)} / ${JSON.stringify(statusB)}`,
  );

  r = await call("eval_js", { code: "document.title" });
  check("session A's current tab unaffected by B's tabs_create", r.text.includes("E2E Page"), r.text);

  const [titleA, titleB, shotA, shotB] = await Promise.all([
    call("eval_js", { code: "await new Promise(r => setTimeout(r, 200)); document.title" }),
    callB("eval_js", { code: "await new Promise(r => setTimeout(r, 200)); document.title" }),
    call("screenshot"),
    callB("screenshot"),
  ]);
  check(
    "concurrent calls hit each session's own tab",
    titleA.text.includes("E2E Page") && titleB.text.includes("Upload Page"),
    `${titleA.text} / ${titleB.text}`,
  );
  check("concurrent screenshots in both windows", !shotA.isError && !shotB.isError, `${shotA.text} / ${shotB.text}`);

  r = await call("eval_js", { code: "1", tabId: tabB });
  check("A cannot touch B's tab → TAB_IN_USE", r.isError && r.text.includes("TAB_IN_USE"), r.text);
  r = await call("tabs_select", { tabId: tabB });
  check("tabs_select on B's tab refused without takeOver", r.isError && r.text.includes("TAB_IN_USE"), r.text);

  const listA = JSON.parse((await call("tabs_list")).text);
  check(
    "tabs_list shows ownership",
    listA.some((t) => t.tabId === tabB && t.owner === statusB.session) && listA.some((t) => t.owner === "this session"),
    JSON.stringify(listA),
  );

  await clientB.client.close();
  clientB = undefined;
  await sleep(500);
  const listAfter = JSON.parse((await call("tabs_list")).text);
  check(
    "ending session B releases its tabs",
    listAfter.some((t) => t.tabId === tabB && t.owner === null),
    JSON.stringify(listAfter),
  );
  r = await call("tabs_select", { tabId: tabB });
  check("released tab can be selected", !r.isError, r.text);

  r = await call("tabs_close");
  check("tabs_close", !r.isError, r.text);
} finally {
  await clientB?.client.close().catch(() => {});
  await client.close().catch(() => {});
  const exited = new Promise((r) => chrome.once("exit", r));
  chrome.kill();
  http.close();
  await Promise.race([exited, sleep(5000)]);
  // Chromium may still flush profile files right after exit.
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  rmSync(files, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
