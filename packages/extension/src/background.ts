import {
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
  PROTOCOL_VERSION,
  type HelloMessage,
  type Message,
} from "@claude-chrome/protocol";
import { detachAll } from "./cdp";
import { dispatch } from "./dispatcher";
import { getSettings } from "./settings";
import { endSession, sessionAlive, sessionsAnnounced } from "./tabs";

export type ConnectionState = "connected" | "connecting" | "disconnected" | "unauthorized" | "replaced" | "paused" | "no_token";

export interface ConnectionStatus {
  state: ConnectionState;
  detail?: string;
  port?: number;
}

// Chrome 116+ keeps the service worker alive while WebSocket traffic flows every <30s.
const HEARTBEAT_MS = 20_000;
const MAX_BACKOFF_MS = 10_000;
const RECONNECT_ALARM = "reconnect";

let socket: WebSocket | null = null;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let backoff = 1000;
let status: ConnectionStatus = { state: "disconnected" };
/** Set before the first await so overlapping triggers (startup, alarm, settings change) share one attempt. */
let connecting: Promise<void> | null = null;

function setStatus(next: ConnectionStatus): void {
  status = next;
  const badge: Partial<Record<ConnectionState, [string, string]>> = {
    connected: ["ON", "#16a34a"],
    unauthorized: ["!", "#dc2626"],
    paused: ["||", "#6b7280"],
    no_token: ["?", "#d97706"],
  };
  const [text, color] = badge[next.state] ?? ["", "#6b7280"];
  chrome.action.setBadgeText({ text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  chrome.runtime.sendMessage({ type: "status", status }).catch(() => {}); // popup may be closed
}

function connect(): Promise<void> {
  connecting ??= openSocket().finally(() => {
    connecting = null;
  });
  return connecting;
}

async function openSocket(): Promise<void> {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(retryTimer);
  const settings = await getSettings();
  if (settings.paused) return setStatus({ state: "paused" });
  if (!settings.token) return setStatus({ state: "no_token", detail: "Paste the token from ~/.claude-chrome/token" });
  if (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535) {
    return setStatus({ state: "disconnected", detail: `Invalid port ${settings.port}` });
  }

  setStatus({ state: "connecting", port: settings.port });
  let ws: WebSocket;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${settings.port}`);
  } catch (error) {
    return setStatus({ state: "disconnected", detail: String(error), port: settings.port });
  }
  socket = ws;

  ws.onopen = () => {
    const hello: HelloMessage = {
      type: "hello",
      role: "extension",
      token: settings.token,
      protocol: PROTOCOL_VERSION,
      client: `chrome-extension ${chrome.runtime.getManifest().version} / ${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? "Chrome"}`,
    };
    ws.send(JSON.stringify(hello));
  };

  ws.onmessage = async (event) => {
    let msg: Message;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "welcome") {
      backoff = 1000;
      setStatus({ state: "connected", port: settings.port });
      clearInterval(heartbeat);
      heartbeat = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), HEARTBEAT_MS);
    } else if (msg.type === "session_end") {
      void endSession(msg.session);
    } else if (msg.type === "sessions") {
      sessionsAnnounced(msg.sessions);
    } else if (msg.type === "session_start") {
      sessionAlive(msg.session);
    } else if (msg.type === "request") {
      sessionAlive(msg.session);
      const response = await dispatch(msg);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(response));
    }
  };

  ws.onclose = (event) => {
    if (socket !== ws) return;
    socket = null;
    clearInterval(heartbeat);
    if (event.code === CLOSE_UNAUTHORIZED) {
      // Wrong token: don't hammer the server; the alarm retries in case the token is fixed server-side.
      setStatus({ state: "unauthorized", detail: event.reason || "Token rejected", port: settings.port });
      return;
    }
    if (event.code === CLOSE_REPLACED) {
      setStatus({ state: "replaced", detail: "Another Chrome profile/extension instance took over the connection." });
      return;
    }
    setStatus({ state: "disconnected", detail: "Local MCP server not running (start a Claude Code session)", port: settings.port });
    retryTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  };
}

function disconnect(): void {
  clearTimeout(retryTimer);
  clearInterval(heartbeat);
  const ws = socket;
  socket = null;
  ws?.close();
}

// Wake-up paths: install/startup, a periodic alarm (survives service-worker suspension), settings changes.
chrome.runtime.onInstalled.addListener(() => void connect());
chrome.runtime.onStartup.addListener(() => void connect());
chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && status.state !== "replaced") void connect();
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (changes.paused?.newValue === true) {
    disconnect();
    await detachAll();
    setStatus({ state: "paused" });
    return;
  }
  if (changes.token || changes.port || changes.paused) {
    disconnect();
    backoff = 1000;
    void connect();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "getStatus") {
    sendResponse(status);
  } else if (message?.type === "reconnect") {
    disconnect();
    backoff = 1000;
    void connect().then(() => sendResponse(status));
    return true;
  } else if (message?.type === "detachAll") {
    void detachAll().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

void connect();
