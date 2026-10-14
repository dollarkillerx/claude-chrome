import { BridgeError } from "@claude-chrome/protocol";
import { cdp, waitForEvent } from "../cdp";
import type { Context, Params } from "../dispatcher";
import { resolveTab } from "../tabs";
import { backendIdForRef } from "./accessibility";
import { click } from "./input";

interface DescribedNode {
  nodeName: string;
  attributes?: string[];
  backendNodeId: number;
}

type NodeTarget = { backendNodeId: number } | { nodeId: number };

const FILE_CHOOSER_TIMEOUT_MS = 5_000;

async function describe(tabId: number, target: NodeTarget): Promise<DescribedNode> {
  const { node } = await cdp<{ node: DescribedNode }>(tabId, "DOM.describeNode", target);
  return node;
}

function attr(node: DescribedNode, name: string): string | undefined {
  const attrs = node.attributes ?? [];
  for (let i = 0; i < attrs.length; i += 2) if (attrs[i].toLowerCase() === name) return attrs[i + 1];
  return undefined;
}

function isFileInput(node: DescribedNode): boolean {
  return node.nodeName === "INPUT" && attr(node, "type")?.toLowerCase() === "file";
}

/** DOM.setFileInputFiles fires input/change events like a real selection. */
async function setFiles(tabId: number, target: NodeTarget, node: DescribedNode, paths: string[]): Promise<void> {
  if (paths.length > 1 && attr(node, "multiple") === undefined) {
    throw new BridgeError("BAD_REQUEST", "This file input accepts a single file; pass one path.");
  }
  await cdp(tabId, "DOM.setFileInputFiles", { files: paths, ...target });
}

export async function fileUpload(params: Params, ctx: Context) {
  const paths = params.paths;
  if (!Array.isArray(paths) || paths.length === 0 || !paths.every((p) => typeof p === "string")) {
    throw new BridgeError("BAD_REQUEST", "paths must be a non-empty array of absolute paths");
  }
  const tab = await resolveTab(ctx.session, params.tabId);
  const names = paths.map((p: string) => p.split("/").pop()).join(", ");

  if (typeof params.ref === "string") {
    const backendNodeId = backendIdForRef(tab.id, params.ref);
    const node = await describe(tab.id, { backendNodeId });
    if (isFileInput(node)) {
      await setFiles(tab.id, { backendNodeId }, node, paths);
      return `Set ${paths.length} file(s) on ${params.ref}: ${names}`;
    }

    // Not an input: treat it as a button that opens a file chooser, and intercept the chooser.
    await cdp(tab.id, "Page.setInterceptFileChooserDialog", { enabled: true });
    try {
      const opened = waitForEvent<{ mode: string; backendNodeId?: number }>(
        tab.id,
        "Page.fileChooserOpened",
        FILE_CHOOSER_TIMEOUT_MS,
      );
      opened.catch(() => {}); // avoid an unhandled rejection if click throws first
      await click({ ref: params.ref, tabId: tab.id }, ctx);
      const chooser = await opened.catch(() => {
        throw new BridgeError("BAD_REQUEST", `Clicking ${params.ref} did not open a file chooser.`);
      });
      if (chooser.mode === "selectSingle" && paths.length > 1) {
        throw new BridgeError("BAD_REQUEST", "This file chooser accepts a single file; pass one path.");
      }
      if (chooser.backendNodeId === undefined) throw new BridgeError("INTERNAL", "File chooser has no input element.");
      await cdp(tab.id, "DOM.setFileInputFiles", { files: paths, backendNodeId: chooser.backendNodeId });
    } finally {
      await cdp(tab.id, "Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
    }
    return `Selected ${paths.length} file(s) via the chooser opened by ${params.ref}: ${names}`;
  }

  // No ref: use the page's only file input. Hidden inputs count, since sites often hide the real one.
  const { root } = await cdp<{ root: { nodeId: number } }>(tab.id, "DOM.getDocument", { depth: 0 });
  const { nodeIds } = await cdp<{ nodeIds: number[] }>(tab.id, "DOM.querySelectorAll", {
    nodeId: root.nodeId,
    selector: "input[type=file]",
  });
  if (nodeIds.length === 0) {
    throw new BridgeError("BAD_REQUEST", "No <input type=file> on the page. Pass the ref of the upload button instead.");
  }
  if (nodeIds.length > 1) {
    throw new BridgeError("BAD_REQUEST", `Found ${nodeIds.length} file inputs; pass ref to choose one (see find "file").`);
  }
  const target = { nodeId: nodeIds[0] };
  await setFiles(tab.id, target, await describe(tab.id, target), paths);
  return `Set ${paths.length} file(s) on the page's file input: ${names}`;
}
