import { BridgeError } from "@claude-chrome/protocol";
import { allowReattach, detachTab } from "./cdp";
import { checkUrl } from "./policy";

/** Per Claude session: its own window, tab group, current tab and owned tabs. */
export interface SessionState {
  label: string;
  currentTabId?: number;
  tabs: number[];
  windowId?: number;
  groupId?: number;
}

/** Persisted in session storage so it survives service-worker restarts (but not browser restarts). */
interface TabState {
  sessions: Record<string, SessionState>;
  nextLabel: number;
}

const GROUP_COLORS = ["orange", "blue", "green", "purple", "cyan", "pink", "yellow", "red"] as const;

/** How long sessions get to re-announce themselves after a hub (re)connects before they count as dead. */
const ORPHAN_GRACE_MS = 15_000;

let loading: Promise<TabState> | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Memoized so concurrent cold-start callers share one read instead of racing (and clobbering) each other. */
function load(): Promise<TabState> {
  loading ??= chrome.storage.session.get("tabState").then(({ tabState }) => {
    const stored = tabState as Partial<TabState> | undefined;
    return { sessions: stored?.sessions ?? {}, nextLabel: stored?.nextLabel ?? 1 };
  });
  return loading;
}

/**
 * Serializes read-modify-write access: concurrent calls from different sessions
 * (e.g. two tabs_create at once) would otherwise clobber each other's updates.
 */
function mutate<T>(fn: (state: TabState) => T | Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const state = await load();
    const result = await fn(state);
    await chrome.storage.session.set({ tabState: state });
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

function sessionOf(state: TabState, session: string): SessionState {
  let s = state.sessions[session];
  if (!s) {
    s = { label: `Claude ${state.nextLabel++}`, tabs: [] };
    state.sessions[session] = s;
  }
  return s;
}

function ownerOf(state: TabState, tabId: number): string | undefined {
  return Object.entries(state.sessions).find(([, s]) => s.tabs.includes(tabId))?.[0];
}

export function getSession(session: string): Promise<SessionState> {
  return mutate((state) => ({ ...sessionOf(state, session) }));
}

/** Label of the session owning each tab, for tabs_list. */
export async function tabOwners(session: string): Promise<(tabId: number) => string | null> {
  const state = await load();
  return (tabId) => {
    const owner = ownerOf(state, tabId);
    if (!owner) return null;
    return owner === session ? "this session" : state.sessions[owner].label;
  };
}

/**
 * Resolves the tab a call should act on, enforcing session ownership and the URL policy.
 * `skipPolicy` is for leaving a blocked page (navigate away, close) so a tab can never get stuck.
 */
export async function resolveTab(
  session: string,
  tabId?: number,
  { skipPolicy = false }: { skipPolicy?: boolean } = {},
): Promise<chrome.tabs.Tab & { id: number }> {
  const state = await load();
  const id = tabId ?? state.sessions[session]?.currentTabId;
  if (id === undefined) {
    throw new BridgeError(
      "NO_TAB_SELECTED",
      "No current tab. Call tabs_create to open one, or tabs_select / pass tabId to use an existing tab.",
    );
  }
  const owner = ownerOf(state, id);
  if (owner && owner !== session) {
    throw new BridgeError(
      "TAB_IN_USE",
      `Tab ${id} belongs to another Claude session (${state.sessions[owner].label}). Open your own tab with tabs_create.`,
    );
  }
  if (!owner) {
    // The user's own tabs must be claimed explicitly, so two sessions can never drive the same tab.
    throw new BridgeError(
      "NO_TAB_SELECTED",
      `Tab ${id} is not one of this session's tabs. Call tabs_select with tabId ${id} first (only if the user wants Claude to use it).`,
    );
  }
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(id);
  } catch {
    throw new BridgeError("TAB_NOT_FOUND", `Tab ${id} does not exist (it may have been closed).`);
  }
  if (!skipPolicy) await checkUrl(tab.url || tab.pendingUrl);
  return tab as chrome.tabs.Tab & { id: number };
}

/** Makes a tab current for the session, claiming it. Tabs of other sessions need `takeOver`. */
export function selectTab(session: string, tabId: number, takeOver: boolean): Promise<void> {
  return mutate((state) => {
    const owner = ownerOf(state, tabId);
    if (owner && owner !== session) {
      if (!takeOver) {
        throw new BridgeError(
          "TAB_IN_USE",
          `Tab ${tabId} belongs to ${state.sessions[owner].label}. Pass takeOver: true only if the user asked for it.`,
        );
      }
      const previous = state.sessions[owner];
      previous.tabs = previous.tabs.filter((id) => id !== tabId);
      if (previous.currentTabId === tabId) previous.currentTabId = undefined;
    }
    const s = sessionOf(state, session);
    if (!s.tabs.includes(tabId)) s.tabs.push(tabId);
    s.currentTabId = tabId;
    void allowReattach(tabId);
  });
}

/**
 * Opens a tab in the session's own window (creating the window on first use) and groups it
 * under the session's label, so concurrent sessions never fight over the active tab.
 */
export function openSessionTab(session: string, url = "about:blank"): Promise<chrome.tabs.Tab & { id: number }> {
  return mutate(async (state) => {
    const s = sessionOf(state, session);
    let tab: chrome.tabs.Tab | undefined;
    if (s.windowId !== undefined) {
      try {
        await chrome.windows.get(s.windowId);
        tab = await chrome.tabs.create({ windowId: s.windowId, url, active: true });
      } catch {
        s.windowId = undefined; // window was closed
        s.groupId = undefined;
      }
    }
    if (!tab) {
      const win = await chrome.windows.create({ url, focused: true });
      s.windowId = win?.id;
      tab = win?.tabs?.[0];
      if (!tab?.id) throw new BridgeError("INTERNAL", "Failed to open a window");
    }
    const id = tab.id!;
    s.tabs.push(id);
    s.currentTabId = id;
    await groupTab(state, s, id);
    return tab as chrome.tabs.Tab & { id: number };
  });
}

async function groupTab(state: TabState, s: SessionState, tabId: number): Promise<void> {
  try {
    if (s.groupId !== undefined) {
      try {
        await chrome.tabs.group({ groupId: s.groupId, tabIds: tabId });
        return;
      } catch {
        s.groupId = undefined; // group was closed
      }
    }
    s.groupId = await chrome.tabs.group({ tabIds: tabId, createProperties: { windowId: s.windowId } });
    const index = Object.values(state.sessions).indexOf(s);
    await chrome.tabGroups.update(s.groupId, {
      title: s.label,
      color: GROUP_COLORS[index % GROUP_COLORS.length] as `${chrome.tabGroups.Color}`,
    });
  } catch {
    // Grouping is cosmetic; never fail the call because of it.
  }
}

/** Drops a session: its tabs stay open for the user, but ownership is released and the debugger detached. */
function releaseSession(state: TabState, session: string): void {
  const s = state.sessions[session];
  if (!s) return;
  for (const tabId of s.tabs) void detachTab(tabId);
  delete state.sessions[session];
}

/** Called when the hub reports a session ended. */
export function endSession(session: string): Promise<void> {
  return mutate((state) => releaseSession(state, session));
}

let announced: Set<string> | null = null;
let sweepTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * A hub just connected and listed its live sessions. Sessions we know that don't show up within the
 * grace period (peers re-electing may announce a little later) belonged to a process that died.
 */
export function sessionsAnnounced(sessions: string[]): void {
  announced = new Set(sessions);
  clearTimeout(sweepTimer);
  sweepTimer = setTimeout(() => {
    const alive = announced;
    announced = null;
    if (!alive) return;
    void mutate((state) => {
      for (const session of Object.keys(state.sessions)) if (!alive.has(session)) releaseSession(state, session);
    });
  }, ORPHAN_GRACE_MS);
}

/** A session showed signs of life (session_start or a request). */
export function sessionAlive(session: string): void {
  announced?.add(session);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void mutate((state) => {
    for (const s of Object.values(state.sessions)) {
      s.tabs = s.tabs.filter((id) => id !== tabId);
      if (s.currentTabId === tabId) s.currentTabId = undefined;
    }
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  void mutate((state) => {
    for (const s of Object.values(state.sessions)) {
      if (s.windowId === windowId) {
        s.windowId = undefined;
        s.groupId = undefined;
      }
    }
  });
});

/**
 * Resolves once the tab finishes loading. Must be created *before* triggering the navigation.
 * Never rejects: on timeout it resolves with `false` so the caller can report "still loading".
 */
export function waitForLoad(tabId: number, timeoutMs = 30_000): Promise<boolean> & { cancel(): void } {
  let cancel = () => {};
  const promise = new Promise<boolean>((resolve) => {
    const started = Date.now();
    let sawLoading = false;
    const finish = (ok: boolean) => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearInterval(poll);
      clearTimeout(timer);
      resolve(ok);
    };
    const onUpdated = (id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (id !== tabId) return;
      if (info.status === "loading") sawLoading = true;
      if (info.status === "complete") finish(true);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    // Fallback for navigations that never emit "loading" (e.g. bfcache restores, same-document changes).
    const poll = setInterval(async () => {
      if (sawLoading || Date.now() - started < 1000) return;
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || tab.status === "complete") finish(Boolean(tab));
    }, 250);
    const timer = setTimeout(() => finish(false), timeoutMs);
    cancel = () => finish(false);
  });
  return Object.assign(promise, { cancel });
}
