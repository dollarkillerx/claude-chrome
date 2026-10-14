import { BridgeError } from "@claude-chrome/protocol";
import { cdp, onDetached } from "../cdp";
import { resolveTab } from "../tabs";
import type { Context, Params } from "../dispatcher";

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

/** Stable ref_N ids per tab, keyed by DOM backend node id so repeated reads keep the same refs. */
interface RefTable {
  next: number;
  byBackend: Map<number, string>;
  byRef: Map<string, number>;
}
const refTables = new Map<number, RefTable>();

onDetached((tabId) => refTables.delete(tabId));
chrome.tabs.onRemoved.addListener((tabId) => refTables.delete(tabId));

function refFor(tabId: number, backendId: number): string {
  let table = refTables.get(tabId);
  if (!table) {
    table = { next: 1, byBackend: new Map(), byRef: new Map() };
    refTables.set(tabId, table);
  }
  let ref = table.byBackend.get(backendId);
  if (!ref) {
    ref = `ref_${table.next++}`;
    table.byBackend.set(backendId, ref);
    table.byRef.set(ref, backendId);
  }
  return ref;
}

export function backendIdForRef(tabId: number, ref: string): number {
  const id = refTables.get(tabId)?.byRef.get(ref);
  if (id === undefined) {
    throw new BridgeError("REF_NOT_FOUND", `Unknown ref ${ref} for tab ${tabId}; call read_page or find first.`);
  }
  return id;
}

async function fetchTree(tabId: number): Promise<{ nodes: Map<string, AXNode>; root: AXNode | undefined }> {
  const { nodes } = await cdp<{ nodes: AXNode[] }>(tabId, "Accessibility.getFullAXTree");
  const map = new Map(nodes.map((n) => [n.nodeId, n]));
  return { nodes: map, root: nodes.find((n) => !n.parentId) ?? nodes[0] };
}

const str = (v: AXValue | undefined) => (v?.value === undefined || v.value === null ? "" : String(v.value));
const quote = (s: string) => JSON.stringify(s.length > 200 ? s.slice(0, 200) + "…" : s);

function describeNode(tabId: number, node: AXNode, role: string): string {
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
  if (node.backendDOMNodeId !== undefined) line += ` [${refFor(tabId, node.backendDOMNodeId)}]`;
  return line;
}

export async function readPage({ tabId, filter, maxChars }: Params, ctx: Context) {
  const tab = await resolveTab(ctx.session, tabId);
  const { nodes, root } = await fetchTree(tab.id);
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
    for (const node of nodes.values()) {
      const role = str(node.role);
      if (!node.ignored && INTERACTIVE_ROLES.has(role)) emit(`- ${describeNode(tab.id, node, role)}`);
    }
  } else if (root) {
    const walk = (node: AXNode, depth: number, parentName: string) => {
      if (truncated) return;
      const role = str(node.role);
      const children = (node.childIds ?? []).map((id) => nodes.get(id)).filter((n): n is AXNode => !!n);
      if (SKIPPED_ROLES.has(role)) return;
      const name = str(node.name).trim();
      if (role === "StaticText") {
        // Skip text that merely repeats its parent's accessible name (e.g. link labels).
        if (name && name !== parentName) emit(`${"  ".repeat(depth)}- text ${quote(name)}`);
        return;
      }
      if (node.ignored || (TRANSPARENT_ROLES.has(role) && !name)) {
        for (const child of children) walk(child, depth, parentName);
        return;
      }
      emit(`${"  ".repeat(depth)}- ${describeNode(tab.id, node, role)}`);
      for (const child of children) walk(child, depth + 1, name);
    };
    walk(root, 0, "");
  }
  if (truncated) lines.push(`…[truncated at ${limit} chars; use filter: "interactive" or find]`);
  return lines.join("\n");
}

export async function find({ query, tabId }: Params, ctx: Context) {
  if (typeof query !== "string" || !query.trim()) throw new BridgeError("BAD_REQUEST", "query is required");
  const tab = await resolveTab(ctx.session, tabId);
  const { nodes } = await fetchTree(tab.id);
  const needle = query.trim().toLowerCase();
  const matches: Array<{ interactive: boolean; line: string }> = [];
  const seen = new Set<number>();

  for (const node of nodes.values()) {
    if (node.ignored) continue;
    const role = str(node.role);
    if (SKIPPED_ROLES.has(role) || TRANSPARENT_ROLES.has(role) && !str(node.name)) continue;
    const haystack = `${role} ${str(node.name)} ${str(node.value)}`.toLowerCase();
    if (!haystack.includes(needle)) continue;
    // Text nodes can't be clicked reliably; point the ref at the containing element.
    let target = node;
    if (role === "StaticText" && node.parentId) target = nodes.get(node.parentId) ?? node;
    if (target.backendDOMNodeId === undefined || seen.has(target.backendDOMNodeId)) continue;
    seen.add(target.backendDOMNodeId);
    const targetRole = str(target.role);
    matches.push({
      interactive: INTERACTIVE_ROLES.has(targetRole),
      line: `- ${describeNode(tab.id, target === node ? node : { ...target, name: node.name }, targetRole)}`,
    });
  }
  if (matches.length === 0) return `No elements matching ${quote(query)}.`;
  matches.sort((a, b) => Number(b.interactive) - Number(a.interactive));
  const shown = matches.slice(0, 20).map((m) => m.line);
  if (matches.length > 20) shown.push(`…and ${matches.length - 20} more; refine the query.`);
  return shown.join("\n");
}
