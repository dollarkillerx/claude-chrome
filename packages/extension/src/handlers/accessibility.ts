import { BridgeError } from "@claude-chrome/protocol";
import { cdp, onDetached } from "../cdp";
import type { Context, Params } from "../dispatcher";
import { listFrames, mainFrame, type FrameDoc } from "../frames";
import { resolveTab } from "../tabs";

interface AXValue {
  value?: unknown;
}

interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: Array<{ name: string; value: AXValue }>;
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
}

export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "listbox",
  "tab",
  "treeitem",
]);
const SKIPPED_ROLES = new Set(["InlineTextBox", "LineBreak"]);
const TRANSPARENT_ROLES = new Set(["generic", "none", "GenericContainer", "paragraph", "LayoutTable", "group"]);
const STATE_PROPS = ["checked", "expanded", "selected", "disabled", "required", "focused", "pressed"];

/** A DOM node addressable by CDP: backend ids are only unique within one session (renderer). */
export interface NodeRef {
  backendNodeId: number;
  session?: string;
}

/** Stable ref_N ids per tab, keyed by session + backend node id so repeated reads keep the same refs. */
interface RefTable {
  next: number;
  byNode: Map<string, string>;
  byRef: Map<string, NodeRef>;
}
const refTables = new Map<number, RefTable>();
const nodeKey = (node: NodeRef) => `${node.session ?? ""}:${node.backendNodeId}`;

onDetached((tabId) => refTables.delete(tabId));
chrome.tabs.onRemoved.addListener((tabId) => refTables.delete(tabId));
// Backend node ids are per renderer and can be reused after a navigation, so a stale ref could
// silently point at an unrelated element. Drop refs whenever the document they belong to navigates.
chrome.debugger.onEvent.addListener((source, method, params: any) => {
  if (method !== "Page.frameNavigated" || source.tabId === undefined || params.frame?.parentId) return;
  const table = refTables.get(source.tabId);
  if (!table) return;
  if (!source.sessionId) {
    refTables.delete(source.tabId); // main frame: everything is stale
    return;
  }
  for (const [ref, node] of table.byRef) {
    if (node.session === source.sessionId) {
      table.byRef.delete(ref);
      table.byNode.delete(nodeKey(node));
    }
  }
});

function refFor(tabId: number, node: NodeRef): string {
  let table = refTables.get(tabId);
  if (!table) {
    table = { next: 1, byNode: new Map(), byRef: new Map() };
    refTables.set(tabId, table);
  }
  const key = nodeKey(node);
  let ref = table.byNode.get(key);
  if (!ref) {
    ref = `ref_${table.next++}`;
    table.byNode.set(key, ref);
    table.byRef.set(ref, node);
  }
  return ref;
}

export function resolveRef(tabId: number, ref: string): NodeRef {
  const node = refTables.get(tabId)?.byRef.get(ref);
  if (!node) {
    throw new BridgeError("REF_NOT_FOUND", `Unknown ref ${ref} for tab ${tabId}; call read_page or find first.`);
  }
  return node;
}

interface DocTree {
  doc: FrameDoc;
  nodes: Map<string, AXNode>;
  root: AXNode | undefined;
}

async function fetchTree(tabId: number, doc: FrameDoc): Promise<DocTree> {
  const { nodes } = await cdp<{ nodes: AXNode[] }>(
    tabId,
    "Accessibility.getFullAXTree",
    { frameId: doc.frameId },
    doc.session,
  );
  const map = new Map(nodes.map((n) => [n.nodeId, n]));
  return { doc, nodes: map, root: nodes.find((n) => !n.parentId) ?? nodes[0] };
}

/** Accessibility trees of every allowed frame document, main frame first. Blocked frames are skipped. */
async function fetchTrees(tabId: number, docs: FrameDoc[]): Promise<DocTree[]> {
  const trees: DocTree[] = [];
  for (const doc of docs) {
    if (!doc.allowed) continue;
    try {
      trees.push(await fetchTree(tabId, doc));
    } catch {
      // Frame detached or not yet loaded.
    }
  }
  return trees;
}

const str = (v: AXValue | undefined) => (v?.value === undefined || v.value === null ? "" : String(v.value));
const quote = (s: string) => JSON.stringify(s.length > 200 ? s.slice(0, 200) + "…" : s);

function hostOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function describeNode(tabId: number, node: AXNode, role: string, session?: string): string {
  const name = str(node.name).trim();
  let line = role;
  if (name) line += ` ${quote(name)}`;
  const value = str(node.value);
  if (value && value !== name) line += ` value=${quote(value)}`;
  for (const prop of node.properties ?? []) {
    if (!STATE_PROPS.includes(prop.name)) continue;
    const v = prop.value.value;
    if (v === false || v === "false" || v === undefined) continue;
    line += v === true || v === "true" ? ` ${prop.name}` : ` ${prop.name}=${v}`;
  }
  if (node.backendDOMNodeId !== undefined) line += ` [${refFor(tabId, { backendNodeId: node.backendDOMNodeId, session })}]`;
  return line;
}

export async function readPage({ tabId, filter, maxChars }: Params, ctx: Context) {
  const tab = await resolveTab(ctx.session, tabId);
  const docs = await listFrames(tab.id);
  const limit = typeof maxChars === "number" ? maxChars : 40_000;
  const lines: string[] = [`URL: ${tab.url}`, `Title: ${tab.title}`, ""];
  let size = 0;
  let truncated = false;
  const emit = (line: string) => {
    if (truncated) return;
    size += line.length + 1;
    if (size > limit) truncated = true;
    else lines.push(line);
  };

  if (filter === "interactive") {
    for (const tree of await fetchTrees(tab.id, docs)) {
      for (const node of tree.nodes.values()) {
        const role = str(node.role);
        if (!node.ignored && INTERACTIVE_ROLES.has(role)) emit(`- ${describeNode(tab.id, node, role, tree.doc.session)}`);
      }
    }
  } else {
    const walkDoc = async (doc: FrameDoc, depth: number): Promise<void> => {
      const tree = await fetchTree(tab.id, doc).catch(() => null);
      if (!tree?.root) return;
      const children = (node: AXNode) =>
        (node.childIds ?? []).map((id) => tree.nodes.get(id)).filter((n): n is AXNode => !!n);
      const walk = async (node: AXNode, depth: number, parentName: string): Promise<void> => {
        if (truncated) return;
        const role = str(node.role);
        if (SKIPPED_ROLES.has(role)) return;
        const name = str(node.name).trim();
        // An <iframe> element: render the child document beneath it (or say it's blocked).
        const frame =
          node.backendDOMNodeId !== undefined
            ? docs.find((d) => d.ownerBackendId === node.backendDOMNodeId && d.ownerSession === doc.session)
            : undefined;
        if (frame) {
          const pad = "  ".repeat(depth);
          if (!frame.allowed) {
            emit(`${pad}- iframe (blocked: ${hostOf(frame.url)})`);
            return;
          }
          emit(`${pad}- iframe ${quote(frame.url)}`);
          await walkDoc(frame, depth + 1);
          return;
        }
        if (role === "StaticText") {
          // Skip text that merely repeats its parent's accessible name (e.g. link labels).
          if (name && name !== parentName) emit(`${"  ".repeat(depth)}- text ${quote(name)}`);
          return;
        }
        if (node.ignored || (TRANSPARENT_ROLES.has(role) && !name)) {
          for (const child of children(node)) await walk(child, depth, parentName);
          return;
        }
        emit(`${"  ".repeat(depth)}- ${describeNode(tab.id, node, role, doc.session)}`);
        for (const child of children(node)) await walk(child, depth + 1, name);
      };
      await walk(tree.root, depth, "");
    };
    await walkDoc(mainFrame(docs), 0);
  }
  if (truncated) lines.push(`…[truncated at ${limit} chars; use filter: "interactive" or find]`);
  return lines.join("\n");
}

export async function find({ query, tabId }: Params, ctx: Context) {
  if (typeof query !== "string" || !query.trim()) throw new BridgeError("BAD_REQUEST", "query is required");
  const tab = await resolveTab(ctx.session, tabId);
  const docs = await listFrames(tab.id);
  const needle = query.trim().toLowerCase();
  const matches: Array<{ interactive: boolean; line: string }> = [];
  const seen = new Set<string>();

  for (const tree of await fetchTrees(tab.id, docs)) {
    const session = tree.doc.session;
    const inFrame = tree.doc.parentFrameId ? ` (in iframe ${hostOf(tree.doc.url)})` : "";
    for (const node of tree.nodes.values()) {
      if (node.ignored) continue;
      const role = str(node.role);
      if (SKIPPED_ROLES.has(role) || (TRANSPARENT_ROLES.has(role) && !str(node.name))) continue;
      const haystack = `${role} ${str(node.name)} ${str(node.value)}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
      // Text nodes can't be clicked reliably; point the ref at the containing element.
      let target = node;
      if (role === "StaticText" && node.parentId) target = tree.nodes.get(node.parentId) ?? node;
      if (target.backendDOMNodeId === undefined) continue;
      const key = nodeKey({ backendNodeId: target.backendDOMNodeId, session });
      if (seen.has(key)) continue;
      seen.add(key);
      const targetRole = str(target.role);
      matches.push({
        interactive: INTERACTIVE_ROLES.has(targetRole),
        line: `- ${describeNode(tab.id, target === node ? node : { ...target, name: node.name }, targetRole, session)}${inFrame}`,
      });
    }
  }
  if (matches.length === 0) return `No elements matching ${quote(query)}.`;
  matches.sort((a, b) => Number(b.interactive) - Number(a.interactive));
  const shown = matches.slice(0, 20).map((m) => m.line);
  if (matches.length > 20) shown.push(`…and ${matches.length - 20} more; refine the query.`);
  return shown.join("\n");
}
