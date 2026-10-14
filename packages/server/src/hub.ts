import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import {
  BridgeError,
  CLOSE_REPLACED,
  CLOSE_UNAUTHORIZED,
  PROTOCOL_VERSION,
  isMethod,
  type HelloMessage,
  type Message,
  type Method,
  type RequestMessage,
  type ResponseMessage,
} from "@claude-chrome/protocol";
import { EXTENSION_WAIT_MS, timeoutFor, type Bridge, type Logger } from "./bridge.js";
import { tokensEqual } from "./token.js";
import { removeSnapshots, snapshotUploads, validateUploadPaths, type UploadPolicy } from "./uploads.js";

export interface HubOptions {
  port: number;
  token: string;
  /** If set, only this extension id may connect as the extension. */
  extensionId?: string;
  extensionWaitMs?: number;
  /** Hint appended to NOT_CONNECTED errors. */
  pairingHint?: string;
  /** This process's own Claude session id. */
  session: string;
  /** Re-applied to file_upload calls relayed from peers, so a peer can't skip the policy. */
  uploadPolicy?: UploadPolicy;
  /** Drop the extension / peers after this long without any message (they ping every 20s). */
  staleMs?: number;
  log: Logger;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: BridgeError): void;
  timer: NodeJS.Timeout;
}

const HELLO_TIMEOUT_MS = 5_000;
const STALE_EXTENSION_MS = 60_000;
const MAYBE_PERFORMED =
  "The action may already have been performed; check the page state (e.g. screenshot or read_page) before retrying.";

/**
 * The hub owns the localhost WebSocket port. The extension connects to it, and so do
 * MCP server processes from other Claude sessions (peers), whose calls are relayed.
 */
export class Hub implements Bridge {
  readonly mode = "hub" as const;
  private extension: WebSocket | null = null;
  private extensionClient = "";
  private extensionLastSeen = 0;
  /** Peer socket → the session it speaks for (bound at hello, so peers can't impersonate others). */
  private peers = new Map<WebSocket, string>();
  private peerLastSeen = new Map<WebSocket, number>();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private extensionWaiters: Array<() => void> = [];
  private closeListeners: Array<() => void> = [];
  private staleTimer: NodeJS.Timeout;

  private constructor(
    private http: Server,
    private wss: WebSocketServer,
    private opts: HubOptions,
  ) {
    wss.on("connection", (socket, req) => this.onConnection(socket, req));
    this.staleTimer = setInterval(() => this.dropStale(), (opts.staleMs ?? STALE_EXTENSION_MS) / 2);
    this.staleTimer.unref();
  }

  /** Binds 127.0.0.1:port. Rejects with an EADDRINUSE error if another hub already runs. */
  static start(opts: HubOptions): Promise<Hub> {
    return new Promise((resolve, reject) => {
      const http = createServer((_req, res) => {
        res.writeHead(426, { "content-type": "text/plain" }).end("WebSocket only\n");
      });
      http.once("error", reject);
      http.listen(opts.port, "127.0.0.1", () => {
        http.off("error", reject);
        // Created only after listen succeeds: ws re-emits server errors, which would go unhandled.
        const wss = new WebSocketServer({ server: http, maxPayload: 64 * 1024 * 1024 });
        wss.on("error", (error) => opts.log(`websocket server error: ${error.message}`));
        resolve(new Hub(http, wss, opts));
      });
    });
  }

  get port(): number {
    const address = this.http.address();
    return typeof address === "object" && address ? address.port : this.opts.port;
  }

  extensionConnected(): boolean {
    return this.extension !== null;
  }

  async call(method: Method, params: Record<string, unknown>, session: string): Promise<unknown> {
    if (method === "status" && !this.extension) {
      return { sessionsOnHub: this.peers.size + 1, extensionConnected: false };
    }
    if (method === "file_upload") {
      // The hub is the last hop before the browser: validate with its policy (peers included) and
      // hand the browser private snapshots so the files can't be swapped after the check.
      const policy = this.opts.uploadPolicy ?? { allowedDirs: [] };
      params = { ...params, paths: await snapshotUploads(validateUploadPaths(params.paths, policy), policy) };
    }
    const result = await this.forward(method, params, session);
    if (method === "status") {
      return { sessionsOnHub: this.peers.size + 1, extensionConnected: true, ...(result as object) };
    }
    return result;
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  async close(): Promise<void> {
    clearInterval(this.staleTimer);
    this.rejectAll(new BridgeError("NOT_CONNECTED", `Hub shutting down. ${MAYBE_PERFORMED}`));
    // Release this session's tabs in the extension; close() flushes the queued message first.
    this.sendToExtension({ type: "session_end", session: this.opts.session });
    for (const client of this.wss.clients) {
      if (client === this.extension) client.close(1001, "hub shutting down");
      else client.terminate();
    }
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    removeSnapshots();
    for (const listener of this.closeListeners.splice(0)) listener();
  }

  private async forward(method: Method, params: Record<string, unknown>, session: string): Promise<unknown> {
    const socket = await this.waitForExtension();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("TIMEOUT", `${method} timed out after ${timeoutFor(method) / 1000}s`));
      }, timeoutFor(method));
      if (socket.readyState !== socket.OPEN) {
        clearTimeout(timer);
        reject(new BridgeError("NOT_CONNECTED", "Chrome extension disconnected; retry the call."));
        return;
      }
      this.pending.set(id, { resolve, reject, timer });
      const request: RequestMessage = { type: "request", id, method, params, session };
      socket.send(JSON.stringify(request));
    });
  }

  private waitForExtension(): Promise<WebSocket> {
    if (this.extension) return Promise.resolve(this.extension);
    const waitMs = this.opts.extensionWaitMs ?? EXTENSION_WAIT_MS;
    return new Promise((resolve, reject) => {
      const onConnect = () => {
        clearTimeout(timer);
        resolve(this.extension!);
      };
      const timer = setTimeout(() => {
        this.extensionWaiters = this.extensionWaiters.filter((w) => w !== onConnect);
        const hint = this.opts.pairingHint ? ` ${this.opts.pairingHint}` : "";
        reject(new BridgeError("NOT_CONNECTED", `Chrome extension is not connected.${hint}`));
      }, waitMs);
      this.extensionWaiters.push(onConnect);
    });
  }

  private onConnection(socket: WebSocket, req: IncomingMessage): void {
    const origin = req.headers.origin;
    const host = req.headers.host ?? "";
    // Guard against DNS rebinding: only accept loopback Host headers.
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      socket.close(CLOSE_UNAUTHORIZED, "bad host");
      return;
    }

    const helloTimer = setTimeout(() => socket.close(CLOSE_UNAUTHORIZED, "hello timeout"), HELLO_TIMEOUT_MS);
    socket.once("message", (raw) => {
      clearTimeout(helloTimer);
      const hello = parse(raw.toString()) as HelloMessage | null;
      const rejection = hello ? this.checkHello(hello, origin) : "malformed hello";
      if (rejection) {
        this.opts.log(`rejected ${hello?.role ?? "unknown"} connection: ${rejection}`);
        socket.close(CLOSE_UNAUTHORIZED, rejection);
        return;
      }
      socket.send(JSON.stringify({ type: "welcome", protocol: PROTOCOL_VERSION }));
      if (hello!.role === "extension") this.attachExtension(socket, hello!.client ?? "");
      else this.attachPeer(socket, hello!.session!);
    });
  }

  private checkHello(hello: HelloMessage, origin: string | undefined): string | null {
    if (hello.type !== "hello" || typeof hello.token !== "string") return "malformed hello";
    if (!tokensEqual(hello.token, this.opts.token)) return "invalid token";
    if (hello.protocol !== PROTOCOL_VERSION) {
      return `protocol version mismatch (got ${hello.protocol}, hub speaks ${PROTOCOL_VERSION}); rebuild and reload`;
    }
    if (hello.role === "extension") {
      if (!origin?.startsWith("chrome-extension://")) return "extension must connect from a chrome-extension:// origin";
      if (this.opts.extensionId && origin !== `chrome-extension://${this.opts.extensionId}`) {
        return "extension id not allowed";
      }
      return null;
    }
    if (hello.role === "peer") {
      // Peers are local Node processes; browsers always send an Origin header.
      if (origin) return "peers must not send an Origin header";
      if (typeof hello.session !== "string" || !hello.session) return "peers must announce a session";
      if (hello.session === this.opts.session || [...this.peers.values()].includes(hello.session)) {
        return "session already connected";
      }
      return null;
    }
    return "unknown role";
  }

  private attachExtension(socket: WebSocket, client: string): void {
    if (this.extension) {
      this.opts.log("a new extension connection replaced the previous one");
      this.extension.close(CLOSE_REPLACED, "replaced by a newer connection");
      // Calls in flight went to the old socket; fail them now instead of letting them time out.
      this.rejectAll(new BridgeError("NOT_CONNECTED", `Chrome extension connection was replaced. ${MAYBE_PERFORMED}`));
    }
    this.extension = socket;
    this.extensionClient = client;
    this.extensionLastSeen = Date.now();
    this.opts.log(`extension connected (${client || "unknown client"})`);

    socket.on("message", (raw) => {
      this.extensionLastSeen = Date.now();
      const msg = parse(raw.toString());
      if (!msg) return;
      if (msg.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      else if (msg.type === "response") this.settle(msg);
    });
    socket.on("close", () => {
      if (this.extension !== socket) return;
      this.extension = null;
      this.opts.log("extension disconnected");
      this.rejectAll(new BridgeError("NOT_CONNECTED", `Chrome extension disconnected during the call. ${MAYBE_PERFORMED}`));
    });

    // Tell the extension which sessions are alive, so it can release tabs of sessions whose process died.
    this.sendToExtension({ type: "sessions", sessions: [this.opts.session, ...this.peers.values()] });
    for (const waiter of this.extensionWaiters.splice(0)) waiter();
  }

  private attachPeer(socket: WebSocket, session: string): void {
    this.peers.set(socket, session);
    this.peerLastSeen.set(socket, Date.now());
    this.sendToExtension({ type: "session_start", session });
    socket.on("close", () => {
      this.peers.delete(socket);
      this.peerLastSeen.delete(socket);
      // Let the extension release the departed session's tabs and window.
      this.sendToExtension({ type: "session_end", session });
    });
    socket.on("message", async (raw) => {
      this.peerLastSeen.set(socket, Date.now());
      const msg = parse(raw.toString());
      if (!msg) return;
      if (msg.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (msg.type !== "request") return;
      const response: ResponseMessage = { type: "response", id: msg.id };
      try {
        if (!isMethod(msg.method)) throw new BridgeError("BAD_REQUEST", `Unknown method ${String(msg.method)}`);
        // Always the session bound at hello; whatever the request claims is ignored.
        response.result = await this.call(msg.method, msg.params ?? {}, session);
      } catch (error) {
        response.error = toRpcError(error);
      }
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(response));
    });
  }

  private sendToExtension(message: Message): void {
    const socket = this.extension;
    if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
  }

  private settle(msg: ResponseMessage): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new BridgeError(msg.error.code, msg.error.message));
    else pending.resolve(msg.result);
  }

  private rejectAll(error: BridgeError): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private dropStale(): void {
    const staleMs = this.opts.staleMs ?? STALE_EXTENSION_MS;
    if (this.extension && Date.now() - this.extensionLastSeen > staleMs) {
      this.opts.log(`extension (${this.extensionClient}) stopped sending heartbeats; dropping it`);
      this.extension.terminate();
    }
    // A hung peer process would otherwise hold its session (and tabs) forever.
    for (const [socket, seen] of this.peerLastSeen) {
      if (Date.now() - seen > staleMs) {
        this.opts.log(`peer session ${this.peers.get(socket)} stopped sending heartbeats; dropping it`);
        socket.terminate();
      }
    }
  }
}

export function parse(raw: string): Message | null {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && typeof value.type === "string" ? (value as Message) : null;
  } catch {
    return null;
  }
}

export function toRpcError(error: unknown) {
  if (error instanceof BridgeError) return error.toJSON();
  return { code: "INTERNAL" as const, message: error instanceof Error ? error.message : String(error) };
}
