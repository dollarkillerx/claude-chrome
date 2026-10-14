import { BridgeError } from "@claude-chrome/protocol";
import { cdp, frameSessions } from "./cdp";
import { isAllowed } from "./policy";

/** One document in the tab: the main frame or an iframe (same-process or out-of-process). */
export interface FrameDoc {
  frameId: string;
  url: string;
  parentFrameId?: string;
  /** CDP child session hosting this document; undefined = the tab's root session. */
  session?: string;
  /** The <iframe> element in the parent document, and the session that hosts it. */
  ownerBackendId?: number;
  ownerSession?: string;
  /** False when this frame (or any ancestor) is blocked by the URL policy. */
  allowed: boolean;
}

interface FrameTree {
  frame: { id: string; parentId?: string; url: string; urlFragment?: string };
  childFrames?: FrameTree[];
}

function flatten(tree: FrameTree, session: string | undefined, out: Map<string, FrameDoc>): void {
  const previous = out.get(tree.frame.id);
  out.set(tree.frame.id, {
    frameId: tree.frame.id,
    url: tree.frame.url + (tree.frame.urlFragment ?? ""),
    // An OOPIF's own tree may not know its parent; keep what the parent's tree told us.
    parentFrameId: tree.frame.parentId ?? previous?.parentFrameId,
    session,
    allowed: true,
  });
  for (const child of tree.childFrames ?? []) flatten(child, session, out);
}

/** Lists every frame document in the tab with its hosting session, owner element and policy verdict. */
export async function listFrames(tabId: number): Promise<FrameDoc[]> {
  const docs = new Map<string, FrameDoc>();
  const { frameTree } = await cdp<{ frameTree: FrameTree }>(tabId, "Page.getFrameTree");
  flatten(frameTree, undefined, docs);
  for (const session of frameSessions(tabId).values()) {
    try {
      const { frameTree: child } = await cdp<{ frameTree: FrameTree }>(tabId, "Page.getFrameTree", undefined, session);
      flatten(child, session, docs);
    } catch {
      // The frame went away while we were listing.
    }
  }
  const list = [...docs.values()];
  for (const doc of list) {
    const parent = doc.parentFrameId ? docs.get(doc.parentFrameId) : undefined;
    if (!parent) continue;
    doc.ownerSession = parent.session;
    try {
      const owner = await cdp<{ backendNodeId: number }>(
        tabId,
        "DOM.getFrameOwner",
        { frameId: doc.frameId },
        parent.session,
      );
      doc.ownerBackendId = owner.backendNodeId;
    } catch {
      // Detached frame.
    }
  }
  // Parents first, so a blocked ancestor blocks its whole subtree.
  const depth = (d: FrameDoc): number => (d.parentFrameId && docs.get(d.parentFrameId) ? depth(docs.get(d.parentFrameId)!) + 1 : 0);
  list.sort((a, b) => depth(a) - depth(b));
  for (const doc of list) {
    const parent = doc.parentFrameId ? docs.get(doc.parentFrameId) : undefined;
    doc.allowed = (!parent || parent.allowed) && (await isAllowed(doc.url));
  }
  return list;
}

export function mainFrame(docs: FrameDoc[]): FrameDoc {
  return docs.find((d) => !d.parentFrameId && !d.session) ?? docs[0];
}

/**
 * Offset of a session's coordinate space within the main viewport. Same-process frames already
 * report main-viewport coordinates; an OOPIF reports coordinates relative to its own viewport.
 */
export async function sessionOffset(tabId: number, docs: FrameDoc[], session?: string): Promise<{ x: number; y: number }> {
  if (!session) return { x: 0, y: 0 };
  const root = docs.find((d) => d.session === session && d.ownerSession !== session && d.ownerBackendId !== undefined);
  if (!root) return { x: 0, y: 0 };
  const { model } = await cdp<{ model: { content: number[] } }>(
    tabId,
    "DOM.getBoxModel",
    { backendNodeId: root.ownerBackendId },
    root.ownerSession,
  );
  const parent = await sessionOffset(tabId, docs, root.ownerSession);
  return { x: model.content[0] + parent.x, y: model.content[1] + parent.y };
}

/** Scrolls the iframe elements hosting `session` into view, outermost first. */
export async function scrollFrameChainIntoView(tabId: number, docs: FrameDoc[], session?: string): Promise<void> {
  if (!session) return;
  const root = docs.find((d) => d.session === session && d.ownerSession !== session && d.ownerBackendId !== undefined);
  if (!root) return;
  await scrollFrameChainIntoView(tabId, docs, root.ownerSession);
  await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: root.ownerBackendId }, root.ownerSession).catch(() => {});
}

/** Refuses coordinates that land inside a frame blocked by the URL policy (including nested OOPIFs). */
export async function assertPointAllowed(tabId: number, x: number, y: number, docs: FrameDoc[]): Promise<void> {
  if (docs.every((d) => d.allowed)) return;
  let session: string | undefined;
  let px = x;
  let py = y;
  for (let hop = 0; hop < 8; hop++) {
    const hit = await cdp<{ backendNodeId: number; frameId?: string }>(
      tabId,
      "DOM.getNodeForLocation",
      { x: Math.round(px), y: Math.round(py), ignorePointerEventsNone: true },
      session,
    ).catch(() => null);
    if (!hit) return;
    const hitDoc = hit.frameId ? docs.find((d) => d.frameId === hit.frameId) : undefined;
    if (hitDoc && !hitDoc.allowed) throw blockedFrame(hitDoc);
    // Landed on an <iframe> element: look inside it.
    const child = docs.find((d) => d.ownerBackendId === hit.backendNodeId && d.ownerSession === session);
    if (!child) return;
    if (!child.allowed) throw blockedFrame(child);
    if (!child.session || child.session === session) return;
    const { model } = await cdp<{ model: { content: number[] } }>(
      tabId,
      "DOM.getBoxModel",
      { backendNodeId: child.ownerBackendId },
      session,
    );
    px -= model.content[0];
    py -= model.content[1];
    session = child.session;
  }
}

function blockedFrame(doc: FrameDoc): BridgeError {
  let host = doc.url;
  try {
    host = new URL(doc.url).hostname || doc.url;
  } catch {
    // keep raw URL
  }
  return new BridgeError("BLOCKED_BY_POLICY", `That point is inside a frame from ${host}, which is blocked.`);
}

/** Hides blocked frames (e.g. for screenshots) and returns a function that restores them. */
export async function hideBlockedFrames(tabId: number, docs: FrameDoc[]): Promise<() => Promise<void>> {
  const outermost = docs.filter((d) => {
    if (d.allowed || d.ownerBackendId === undefined) return false;
    const parent = docs.find((p) => p.frameId === d.parentFrameId);
    return !parent || parent.allowed;
  });
  const hidden: Array<{ objectId: string; session?: string }> = [];
  for (const doc of outermost) {
    try {
      const { object } = await cdp<{ object: { objectId: string } }>(
        tabId,
        "DOM.resolveNode",
        { backendNodeId: doc.ownerBackendId },
        doc.ownerSession,
      );
      await cdp(
        tabId,
        "Runtime.callFunctionOn",
        {
          objectId: object.objectId,
          functionDeclaration:
            "function () { this.dataset.claudeChromeVisibility = this.style.visibility; this.style.visibility = 'hidden'; }",
        },
        doc.ownerSession,
      );
      hidden.push({ objectId: object.objectId, session: doc.ownerSession });
    } catch {
      // Frame vanished; nothing to hide.
    }
  }
  return async () => {
    for (const { objectId, session } of hidden) {
      await cdp(
        tabId,
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration:
            "function () { this.style.visibility = this.dataset.claudeChromeVisibility || ''; delete this.dataset.claudeChromeVisibility; }",
        },
        session,
      ).catch(() => {});
    }
  };
}

// --- isolated-world evaluation ----------------------------------------------------------------
// Internal reads (viewport size, page text, scroll position) run in an isolated world: it shares
// the DOM but not the page's JavaScript globals, so a page can't spoof innerWidth or querySelector.

const contexts = new Map<string, number>();
const contextKey = (tabId: number, session: string | undefined, frameId: string) => `${tabId}|${session ?? ""}|${frameId}`;

chrome.debugger.onEvent.addListener((source, method, params: any) => {
  if (source.tabId === undefined) return;
  const prefix = `${source.tabId}|${source.sessionId ?? ""}|`;
  if (method === "Runtime.executionContextsCleared") {
    for (const key of [...contexts.keys()]) if (key.startsWith(prefix)) contexts.delete(key);
  } else if (method === "Runtime.executionContextDestroyed") {
    for (const [key, id] of contexts) if (key.startsWith(prefix) && id === params.executionContextId) contexts.delete(key);
  }
});

interface EvaluateResponse {
  result: { type: string; value?: unknown; description?: string };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

export async function evaluateIsolated(
  tabId: number,
  expression: string,
  { frameId, session }: { frameId?: string; session?: string } = {},
): Promise<unknown> {
  const frame =
    frameId ?? (await cdp<{ frameTree: FrameTree }>(tabId, "Page.getFrameTree", undefined, session)).frameTree.frame.id;
  const key = contextKey(tabId, session, frame);
  for (let attempt = 0; attempt < 2; attempt++) {
    let contextId = contexts.get(key);
    if (contextId === undefined) {
      ({ executionContextId: contextId } = await cdp<{ executionContextId: number }>(
        tabId,
        "Page.createIsolatedWorld",
        { frameId: frame, worldName: "claude-chrome" },
        session,
      ));
      contexts.set(key, contextId);
    }
    try {
      const response = await cdp<EvaluateResponse>(
        tabId,
        "Runtime.evaluate",
        { expression, contextId, returnByValue: true, awaitPromise: true },
        session,
      );
      if (response.exceptionDetails) {
        const d = response.exceptionDetails;
        throw new BridgeError("INTERNAL", d.exception?.description ?? d.text);
      }
      return response.result.value;
    } catch (error) {
      // The context died with a navigation; create a fresh one once.
      if (attempt === 0 && /context/i.test(String((error as Error).message))) {
        contexts.delete(key);
        continue;
      }
      throw error;
    }
  }
  throw new BridgeError("INTERNAL", "Could not evaluate in the page");
}

export interface Viewport {
  width: number;
  height: number;
  dpr: number;
  pageX: number;
  pageY: number;
}

/** Layout viewport size and scroll offset of the main frame, read in the isolated world. */
export async function viewport(tabId: number): Promise<Viewport> {
  return evaluateIsolated(
    tabId,
    `({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
        pageX: visualViewport ? visualViewport.pageLeft : scrollX,
        pageY: visualViewport ? visualViewport.pageTop : scrollY })`,
  ) as Promise<Viewport>;
}
