import { randomUUID } from "node:crypto";
import type { Method } from "@claude-chrome/protocol";
import type { Bridge, Logger } from "./bridge.js";
import { Hub } from "./hub.js";
import { Peer } from "./peer.js";
import type { UploadPolicy } from "./uploads.js";

export interface ManagerOptions {
  port: number;
  token: string;
  uploadPolicy?: UploadPolicy;
  extensionId?: string;
  pairingHint?: string;
  log: Logger;
}

/**
 * Elects this process as hub (owns the port) or peer (relays through the existing hub).
 * When a peer loses its hub, it re-elects so the extension always has someone to connect to.
 */
export class BridgeManager {
  private bridge: Bridge | null = null;
  private electing: Promise<Bridge> | null = null;
  private closed = false;
  /** Stable for the life of this process, so re-elections keep the same tab ownership in the extension. */
  readonly sessionId = randomUUID();

  constructor(private opts: ManagerOptions) {}

  get mode(): "hub" | "peer" | "none" {
    return this.bridge?.mode ?? "none";
  }

  async call(method: Method, params: Record<string, unknown>): Promise<unknown> {
    const bridge = await this.get();
    return bridge.call(method, params, this.sessionId);
  }

  get(): Promise<Bridge> {
    if (this.bridge) return Promise.resolve(this.bridge);
    this.electing ??= this.elect().finally(() => {
      this.electing = null;
    });
    return this.electing;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.bridge?.close();
    this.bridge = null;
  }

  private async elect(): Promise<Bridge> {
    const { port, token, log } = this.opts;
    let bridge: Bridge;
    try {
      bridge = await Hub.start({
        port,
        token,
        extensionId: this.opts.extensionId,
        pairingHint: this.opts.pairingHint,
        session: this.sessionId,
        uploadPolicy: this.opts.uploadPolicy,
        log,
      });
      log(`listening on ws://127.0.0.1:${port} as hub`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      bridge = await Peer.connect({ port, token, session: this.sessionId, log });
    }
    this.bridge = bridge;
    bridge.onClose(() => {
      if (this.bridge === bridge) this.bridge = null;
      if (this.closed) return;
      // Jitter so multiple orphaned peers don't all race for the port at once.
      setTimeout(() => this.get().catch((e) => log(`re-election failed: ${e.message}`)), 200 + Math.random() * 800);
    });
    return bridge;
  }
}
