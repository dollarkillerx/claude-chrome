import WebSocket from "ws";
import {
  BridgeError,
  CLOSE_UNAUTHORIZED,
  PROTOCOL_VERSION,
  type HelloMessage,
  type Method,
  type RequestMessage,
} from "@claude-chrome/protocol";
import { EXTENSION_WAIT_MS, timeoutFor, type Bridge, type Logger } from "./bridge.js";
import { parse } from "./hub.js";

export interface PeerOptions {
  port: number;
  token: string;
  /** This process's Claude session id, bound to the connection by the hub. */
  session: string;
  log: Logger;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: BridgeError): void;
  timer: NodeJS.Timeout;
}

const HEARTBEAT_MS = 20_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;

/** Used when another Claude session already owns the port: relays calls through that hub. */
export class Peer implements Bridge {
  readonly mode = "peer" as const;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private closeListeners: Array<() => void> = [];
  private heartbeat: NodeJS.Timeout;

  private constructor(
    private socket: WebSocket,
    private opts: PeerOptions,
  ) {
    socket.on("message", (raw) => {
      const msg = parse(raw.toString());
      if (msg?.type !== "response") return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new BridgeError(msg.error.code, msg.error.message));
      else pending.resolve(msg.result);
    });
    socket.on("close", () => {
      clearInterval(this.heartbeat);
      for (const [id, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(
          new BridgeError(
            "NOT_CONNECTED",
            "Lost connection to the hub. The action may already have been performed; check the page state before retrying.",
          ),
        );
        this.pending.delete(id);
      }
      this.opts.log("disconnected from hub");
      for (const listener of this.closeListeners.splice(0)) listener();
    });
    socket.on("error", (error) => this.opts.log(`hub connection error: ${error.message}`));
    this.heartbeat = setInterval(() => socket.send(JSON.stringify({ type: "ping" })), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  static connect(opts: PeerOptions): Promise<Peer> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${opts.port}`, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
      let welcomed = false;
      // Something may accept TCP but never answer (wedged hub, foreign service): don't hang the election.
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error(`No hub answered on port ${opts.port} within ${HANDSHAKE_TIMEOUT_MS / 1000}s`));
      }, HANDSHAKE_TIMEOUT_MS);
      socket.once("open", () => {
        const hello: HelloMessage = {
          type: "hello",
          role: "peer",
          token: opts.token,
          protocol: PROTOCOL_VERSION,
          session: opts.session,
        };
        socket.send(JSON.stringify(hello));
      });
      socket.once("message", (raw) => {
        clearTimeout(timer);
        const msg = parse(raw.toString());
        if (msg?.type !== "welcome") {
          socket.terminate();
          reject(new Error("Unexpected handshake reply from the process on the port"));
          return;
        }
        welcomed = true;
        opts.log(`connected to existing hub on port ${opts.port} as a peer`);
        resolve(new Peer(socket, opts));
      });
      socket.once("close", (code, reason) => {
        clearTimeout(timer);
        if (welcomed) return;
        reject(
          code === CLOSE_UNAUTHORIZED
            ? new BridgeError("UNAUTHORIZED", `Hub rejected this process: ${reason.toString()}`)
            : new Error(`Port ${opts.port} is in use but no hub answered (close code ${code})`),
        );
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        if (!welcomed) reject(error);
      });
    });
  }

  call(method: Method, params: Record<string, unknown>, session: string): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BridgeError("NOT_CONNECTED", "Not connected to the hub"));
    }
    const id = this.nextId++;
    // The hub may first wait for the extension, then apply its own per-method timeout.
    const timeoutMs = EXTENSION_WAIT_MS + timeoutFor(method) + 5_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("TIMEOUT", `${method} timed out waiting for the hub`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const request: RequestMessage = { type: "request", id, method, params, session };
      this.socket.send(JSON.stringify(request));
    });
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  async close(): Promise<void> {
    this.socket.close();
  }
}
