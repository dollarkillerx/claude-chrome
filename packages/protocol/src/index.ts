// Wire protocol shared by the MCP server (hub / peer) and the Chrome extension.
// All messages are JSON objects sent over a single WebSocket.

export const DEFAULT_PORT = 18765;
export const PROTOCOL_VERSION = 1;

export type Role = "extension" | "peer";

export interface HelloMessage {
  type: "hello";
  role: Role;
  token: string;
  protocol: number;
  /** Free-form client description, e.g. extension version / user agent. */
  client?: string;
}

export interface WelcomeMessage {
  type: "welcome";
  protocol: number;
}

export interface RequestMessage {
  type: "request";
  id: number;
  method: Method;
  params: Record<string, unknown>;
  /** Opaque id of the Claude session that issued the call; the extension isolates tabs per session. */
  session: string;
}

/** Hub → extension: a Claude session went away, so its tab bookkeeping can be dropped. */
export interface SessionEndMessage {
  type: "session_end";
  session: string;
}

export interface ResponseMessage {
  type: "response";
  id: number;
  result?: unknown;
  error?: RpcError;
}

export interface PingMessage {
  type: "ping";
}

export interface PongMessage {
  type: "pong";
}

export type Message =
  | HelloMessage
  | WelcomeMessage
  | RequestMessage
  | ResponseMessage
  | SessionEndMessage
  | PingMessage
  | PongMessage;

export type ErrorCode =
  | "NOT_CONNECTED"
  | "UNAUTHORIZED"
  | "TIMEOUT"
  | "TAB_NOT_FOUND"
  | "NO_TAB_SELECTED"
  | "TAB_IN_USE"
  | "BLOCKED_BY_POLICY"
  | "REF_NOT_FOUND"
  | "PAUSED"
  | "JS_EXCEPTION"
  | "BAD_REQUEST"
  | "INTERNAL";

export interface RpcError {
  code: ErrorCode;
  message: string;
}

export class BridgeError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }

  toJSON(): RpcError {
    return { code: this.code, message: this.message };
  }
}

/** Close codes used when the hub rejects a socket. */
export const CLOSE_UNAUTHORIZED = 4001;
export const CLOSE_REPLACED = 4002;

export const METHODS = [
  "status",
  "tabs_list",
  "tabs_create",
  "tabs_select",
  "tabs_close",
  "navigate",
  "screenshot",
  "read_page",
  "find",
  "click",
  "hover",
  "type",
  "key",
  "scroll",
  "get_page_text",
  "eval_js",
  "console_logs",
  "file_upload",
] as const;

export type Method = (typeof METHODS)[number];

export function isMethod(value: unknown): value is Method {
  return typeof value === "string" && (METHODS as readonly string[]).includes(value);
}

/** Result shape for screenshot so the server can turn it into MCP image content. */
export interface ScreenshotResult {
  mimeType: "image/png" | "image/jpeg";
  data: string; // base64
  width: number;
  height: number;
  /** Extra context for the model, e.g. that coordinates are not viewport-relative. */
  note?: string;
}
