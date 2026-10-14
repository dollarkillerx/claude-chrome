import type { Method } from "@claude-chrome/protocol";

/** Something that can forward a tool call to the extension, either directly (hub) or via the hub (peer). */
export interface Bridge {
  readonly mode: "hub" | "peer";
  /** `session` identifies the calling Claude session so the extension can isolate its tabs. */
  call(method: Method, params: Record<string, unknown>, session: string): Promise<unknown>;
  close(): Promise<void>;
  /** Fires once when the bridge dies (e.g. a peer lost its hub), so the caller can re-elect. */
  onClose(listener: () => void): void;
}

/** How long the hub waits for the extension to (re)connect before failing a call. */
export const EXTENSION_WAIT_MS = 30_000;

/** Per-method timeouts once the request reached the extension. */
export function timeoutFor(method: Method): number {
  switch (method) {
    case "navigate":
    case "tabs_create":
      return 45_000;
    case "eval_js":
    case "screenshot":
    case "file_upload":
      return 30_000;
    default:
      return 20_000;
  }
}

export type Logger = (message: string) => void;

/** stdout carries the MCP protocol, so all diagnostics go to stderr. */
export const stderrLogger: Logger = (message) => {
  process.stderr.write(`[claude-chrome] ${message}\n`);
};
