// Shared harness for browser-level tests: launches Chromium with the built extension, serves test
// pages, spawns MCP server processes (one per simulated Claude session) and talks CDP directly.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

export const root = resolve(import.meta.dirname, "../../..");
export const extensionDir = join(root, "packages/extension/dist");
export const serverEntry = join(root, "packages/server/dist/index.js");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const EXTENSION_NAME = "Local Chrome for Claude";

/** Sends one CDP command over a fresh connection and returns its result (skipping events). */
export async function cdpCommand(wsUrl, method, params = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  ws.send(JSON.stringify({ id: 1, method, params }));
  const msg = await new Promise((r) =>
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.id === 1) r(m);
    }),
  );
  ws.close();
  if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
  return msg.result;
}

export async function startEnv() {
  const chromePath = process.env.CHROME_PATH;
  if (!chromePath) throw new Error("Set CHROME_PATH to a Chromium / Chrome for Testing binary");
  const token = randomBytes(12).toString("hex");
  const port = 30000 + Math.floor(Math.random() * 20000);
  const home = mkdtempSync(join(tmpdir(), "claude-chrome-sys-"));

  // --- test pages ------------------------------------------------------------
  const routes = new Map();
  const requestListeners = [];
  const http = createServer((req, res) => {
    for (const listener of requestListeners) listener(req.url);
    const route = routes.get(req.url.split("?")[0]);
    if (!route) return res.writeHead(404).end("not found");
    if (route.redirect) return res.writeHead(302, { location: route.redirect }).end();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(route.html);
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${http.address().port}`;

  // --- browser -----------------------------------------------------------------
  // Branded Chrome 137+ ignores --load-extension, so load the extension over a CDP pipe with
  // Extensions.loadUnpacked (needs --enable-unsafe-extension-debugging). This works for Chromium,
  // Chrome for Testing and regular Chrome alike. A throwaway profile keeps the user's Chrome untouched.
  const profile = join(home, "profile");
  const chrome = spawn(
    chromePath,
    [
      `--user-data-dir=${profile}`,
      "--remote-debugging-pipe",
      "--remote-debugging-port=0",
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] },
  );
  const browserVersion = await loadExtensionOverPipe(chrome, extensionDir);
  let cdpPort;
  for (let i = 0; i < 100 && !cdpPort; i++) {
    const file = join(profile, "DevToolsActivePort");
    if (existsSync(file)) cdpPort = Number(readFileSync(file, "utf8").split("\n")[0]);
    else await sleep(100);
  }
  if (!cdpPort) throw new Error("Chromium did not start");
  const cdpHttp = `http://127.0.0.1:${cdpPort}`;

  const env = {
    browserVersion,
    token,
    port,
    home,
    base,
    chrome,
    clients: [],
    /** Observe every request to the test page server (e.g. to detect visits to bait URLs). */
    onRequest(listener) {
      requestListeners.push(listener);
    },
    route(path, html) {
      routes.set(path, { html });
      return base + path;
    },
    redirect(path, to) {
      routes.set(path, { redirect: to });
      return base + path;
    },
    async targets() {
      return fetch(`${cdpHttp}/json/list`).then((r) => r.json());
    },
    async browserWs() {
      return (await fetch(`${cdpHttp}/json/version`).then((r) => r.json())).webSocketDebuggerUrl;
    },
    /** Our extension's service-worker target (Chromium ships other component extensions too). */
    async extensionWorker(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        for (const t of await env.targets()) {
          if (t.type !== "service_worker" || !t.url.startsWith("chrome-extension://")) continue;
          const name = await cdpCommand(t.webSocketDebuggerUrl, "Runtime.evaluate", {
            expression: "chrome.runtime.getManifest().name",
            returnByValue: true,
          }).catch(() => null);
          if (name?.result?.value === EXTENSION_NAME) return t;
        }
        await sleep(200);
      }
      return null;
    },
    /** Evaluates in the extension service worker (to tweak settings like a user would in the popup). */
    async extEval(expression) {
      const worker = await env.extensionWorker();
      if (!worker) throw new Error("extension service worker not found");
      const res = await cdpCommand(worker.webSocketDebuggerUrl, "Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      return res.result?.value;
    },
    async pair() {
      await env.extEval(`chrome.storage.local.set(${JSON.stringify({ token, port })})`);
    },
    /** One MCP client == one simulated Claude session == one server process. */
    async connectClient(name, extraEnv = {}) {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverEntry],
        env: {
          ...process.env,
          CLAUDE_CHROME_TOKEN: token,
          CLAUDE_CHROME_PORT: String(port),
          CLAUDE_CHROME_HOME: home,
          ...extraEnv,
        },
        stderr: "pipe",
      });
      const logs = [];
      const client = new Client({ name, version: "0" });
      await client.connect(transport);
      transport.stderr?.on("data", (d) => logs.push(d.toString()));
      const call = async (tool, args = {}) => {
        const started = performance.now();
        const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 });
        const text = res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
        return { ...res, text, ms: performance.now() - started };
      };
      const handle = { name, client, transport, call, logs, pid: transport.pid };
      env.clients.push(handle);
      return handle;
    },
    async waitConnected(call, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const r = await call("status");
        if (!r.isError && JSON.parse(r.text).extensionConnected) return true;
        await sleep(200);
      }
      return false;
    },
    async close() {
      for (const c of env.clients) await c.client.close().catch(() => {});
      const exited = new Promise((r) => chrome.once("exit", r));
      chrome.kill();
      http.close();
      await Promise.race([exited, sleep(5000)]);
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
  return env;
}

/** Talks CDP over the --remote-debugging-pipe file descriptors (NUL-delimited JSON). */
async function loadExtensionOverPipe(chrome, dir) {
  const [, , , input, output] = chrome.stdio;
  let buffer = "";
  const pending = new Map();
  output.on("data", (chunk) => {
    buffer += chunk.toString();
    for (let i; (i = buffer.indexOf("\0")) >= 0; ) {
      const message = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      pending.get(message.id)?.(message);
    }
  });
  let nextId = 1;
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
      input.write(JSON.stringify({ id, method, params }) + "\0");
    });
  const { product } = await send("Browser.getVersion");
  await send("Extensions.loadUnpacked", { path: dir });
  return product;
}

/** Collects named checks into a JSON-serializable result list. */
export function createRecorder() {
  const results = [];
  let category = "general";
  return {
    results,
    section(name) {
      category = name;
      console.log(`\n## ${name}`);
    },
    check(name, ok, detail = "", extra = {}) {
      results.push({ category, name, ok: Boolean(ok), detail: String(detail).slice(0, 600), ...extra });
      console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  →  ${String(detail).slice(0, 300)}`}`);
    },
    info(name, detail, extra = {}) {
      results.push({ category, name, ok: true, info: true, detail: String(detail).slice(0, 600), ...extra });
      console.log(`• ${name}: ${detail}`);
    },
  };
}

export const refOf = (text, pattern) => text.split("\n").find((l) => pattern.test(l))?.match(/\[(ref_\d+)\]/)?.[1];
export const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
