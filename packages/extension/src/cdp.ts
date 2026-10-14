import { BridgeError } from "@claude-chrome/protocol";

export interface ConsoleEntry {
  level: string;
  text: string;
  url?: string;
  time: number;
}

const CONSOLE_LIMIT = 200;
const attached = new Set<number>();
/**
 * Tabs where the user clicked "Cancel" on Chrome's debugging banner; don't silently re-attach.
 * Persisted so a service-worker restart doesn't forget the user's decision.
 */
const canceledByUser = new Set<number>();
const canceledLoaded = chrome.storage.session.get("canceledByUser").then(({ canceledByUser: ids }) => {
  for (const id of (ids as number[] | undefined) ?? []) canceledByUser.add(id);
});
function saveCanceled(): Promise<void> {
  return chrome.storage.session.set({ canceledByUser: [...canceledByUser] });
}
const consoleBuffers = new Map<number, ConsoleEntry[]>();
const detachListeners: Array<(tabId: number) => void> = [];
const eventWaiters = new Set<{ tabId: number; method: string; resolve(params: any): void }>();

export function onDetached(listener: (tabId: number) => void): void {
  detachListeners.push(listener);
}

export function attachedTabs(): number[] {
  return [...attached];
}

/** Allow re-attaching after the user canceled the banner (Claude selected the tab explicitly). */
export async function allowReattach(tabId: number): Promise<void> {
  await canceledLoaded;
  if (canceledByUser.delete(tabId)) await saveCanceled();
}

export async function detachTab(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return;
  await chrome.debugger.detach({ tabId }).catch(() => {});
  cleanup(tabId);
}

export async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) return;
  await canceledLoaded;
  if (canceledByUser.has(tabId)) {
    throw new BridgeError(
      "BLOCKED_BY_POLICY",
      `The user stopped debugging tab ${tabId}. Ask the user before calling tabs_select on it again.`,
    );
  }
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    // After a service-worker restart our own session may still be attached.
    if (!/already attached/i.test(message)) throw mapChromeError(error);
  }
  attached.add(tabId);
  consoleBuffers.set(tabId, consoleBuffers.get(tabId) ?? []);
  await Promise.all([send(tabId, "Runtime.enable"), send(tabId, "Log.enable"), send(tabId, "Page.enable")]);
}

export async function send<T = any>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  try {
    return (await chrome.debugger.sendCommand({ tabId }, method, params)) as T;
  } catch (error) {
    throw mapChromeError(error);
  }
}

/** Attach (if needed) and send. */
export async function cdp<T = any>(tabId: number, method: string, params?: Record<string, unknown>): Promise<T> {
  await ensureAttached(tabId);
  return send<T>(tabId, method, params);
}

export async function detachAll(): Promise<void> {
  await Promise.all([...attached].map((tabId) => chrome.debugger.detach({ tabId }).catch(() => {})));
  for (const tabId of [...attached]) cleanup(tabId);
}

/**
 * Waits for a CDP event on a tab. Create the waiter *before* triggering the action that emits it.
 * Rejects with TIMEOUT if it doesn't arrive.
 */
export function waitForEvent<T = any>(tabId: number, method: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const waiter = {
      tabId,
      method,
      resolve: (params: T) => {
        clearTimeout(timer);
        eventWaiters.delete(waiter);
        resolve(params);
      },
    };
    const timer = setTimeout(() => {
      eventWaiters.delete(waiter);
      reject(new BridgeError("TIMEOUT", `${method} did not happen within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    eventWaiters.add(waiter);
  });
}

export function readConsole(tabId: number): ConsoleEntry[] {
  return consoleBuffers.get(tabId) ?? [];
}

export function clearConsole(tabId: number): void {
  consoleBuffers.set(tabId, []);
}

function cleanup(tabId: number): void {
  attached.delete(tabId);
  for (const listener of detachListeners) listener(tabId);
}

function pushConsole(tabId: number, entry: ConsoleEntry): void {
  const buffer = consoleBuffers.get(tabId) ?? [];
  buffer.push(entry);
  if (buffer.length > CONSOLE_LIMIT) buffer.splice(0, buffer.length - CONSOLE_LIMIT);
  consoleBuffers.set(tabId, buffer);
}

function remoteObjectText(arg: any): string {
  if (arg.type === "string") return arg.value;
  if (arg.value !== undefined) return JSON.stringify(arg.value);
  return arg.unserializableValue ?? arg.description ?? arg.type;
}

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === undefined) return;
  if (reason === "canceled_by_user") {
    canceledByUser.add(source.tabId);
    void saveCanceled();
  }
  cleanup(source.tabId);
});

chrome.debugger.onEvent.addListener((source, method, params: any) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  for (const waiter of eventWaiters) {
    if (waiter.tabId === tabId && waiter.method === method) waiter.resolve(params);
  }
  if (method === "Runtime.consoleAPICalled") {
    const frame = params.stackTrace?.callFrames?.[0];
    pushConsole(tabId, {
      level: params.type,
      text: (params.args ?? []).map(remoteObjectText).join(" "),
      url: frame ? `${frame.url}:${frame.lineNumber + 1}` : undefined,
      time: params.timestamp,
    });
  } else if (method === "Runtime.exceptionThrown") {
    const details = params.exceptionDetails;
    pushConsole(tabId, {
      level: "exception",
      text: details.exception?.description ?? details.text,
      url: details.url ? `${details.url}:${details.lineNumber + 1}` : undefined,
      time: params.timestamp,
    });
  } else if (method === "Log.entryAdded") {
    pushConsole(tabId, {
      level: params.entry.level,
      text: params.entry.text,
      url: params.entry.url,
      time: params.entry.timestamp,
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (canceledByUser.delete(tabId)) void saveCanceled();
  consoleBuffers.delete(tabId);
  if (attached.has(tabId)) cleanup(tabId);
});

export function mapChromeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  const message = (error as Error)?.message ?? String(error);
  if (/No tab with (given )?id/i.test(message)) return new BridgeError("TAB_NOT_FOUND", message);
  if (/No node (with given id )?found|Could not find node|Node with given id does not belong/i.test(message)) {
    return new BridgeError("REF_NOT_FOUND", "Element ref is stale (page changed); call read_page or find again.");
  }
  if (/Cannot access|Cannot attach|chrome:\/\/|extensions gallery/i.test(message)) {
    return new BridgeError("BLOCKED_BY_POLICY", message);
  }
  return new BridgeError("INTERNAL", message);
}
