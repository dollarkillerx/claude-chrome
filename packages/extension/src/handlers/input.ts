import { BridgeError } from "@claude-chrome/protocol";
import { cdp } from "../cdp";
import { resolveTab } from "../tabs";
import { backendIdForRef } from "./accessibility";
import { viewport } from "./screenshot";
import type { Context, Params } from "../dispatcher";

interface Point {
  x: number;
  y: number;
}

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  option: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

function modifierMask(spec: unknown): number {
  if (typeof spec !== "string" || !spec) return 0;
  return spec.split("+").reduce((mask, part) => {
    const bit = MODIFIER_BITS[part.trim().toLowerCase()];
    if (bit === undefined) throw new BridgeError("BAD_REQUEST", `Unknown modifier "${part}"`);
    return mask | bit;
  }, 0);
}

/** Resolves a ref (scrolling it into view) or a coordinate to a viewport point in CSS pixels. */
async function resolvePoint(tabId: number, params: Params, fallbackToCenter = false): Promise<Point> {
  if (typeof params.ref === "string") {
    const backendNodeId = backendIdForRef(tabId, params.ref);
    await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
    const { quads } = await cdp<{ quads: number[][] }>(tabId, "DOM.getContentQuads", { backendNodeId });
    const quad = quads?.[0];
    if (!quad) throw new BridgeError("REF_NOT_FOUND", `${params.ref} is not visible (no layout box).`);
    return {
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
    };
  }
  if (Array.isArray(params.coordinate) && params.coordinate.length === 2) {
    const [x, y] = params.coordinate.map(Number);
    return { x, y };
  }
  if (fallbackToCenter) {
    const vp = await viewport(tabId);
    return { x: vp.width / 2, y: vp.height / 2 };
  }
  throw new BridgeError("BAD_REQUEST", "Provide either ref or coordinate.");
}

function mouse(tabId: number, params: Record<string, unknown>) {
  return cdp(tabId, "Input.dispatchMouseEvent", params);
}

export async function click(params: Params, ctx: Context) {
  const tab = await resolveTab(ctx.session, params.tabId);
  const point = await resolvePoint(tab.id, params);
  const button = params.button ?? "left";
  const modifiers = modifierMask(params.modifiers);
  const count = typeof params.clickCount === "number" ? params.clickCount : 1;
  await mouse(tab.id, { type: "mouseMoved", ...point, modifiers });
  for (let i = 1; i <= count; i++) {
    await mouse(tab.id, { type: "mousePressed", ...point, button, clickCount: i, modifiers });
    await mouse(tab.id, { type: "mouseReleased", ...point, button, clickCount: i, modifiers });
  }
  return `Clicked at (${Math.round(point.x)}, ${Math.round(point.y)}).`;
}

export async function hover(params: Params, ctx: Context) {
  const tab = await resolveTab(ctx.session, params.tabId);
  const point = await resolvePoint(tab.id, params);
  await mouse(tab.id, { type: "mouseMoved", ...point });
  return `Hovering at (${Math.round(point.x)}, ${Math.round(point.y)}).`;
}

export async function type(params: Params, ctx: Context) {
  if (typeof params.text !== "string") throw new BridgeError("BAD_REQUEST", "text is required");
  const tab = await resolveTab(ctx.session, params.tabId);
  if (typeof params.ref === "string") {
    const backendNodeId = backendIdForRef(tab.id, params.ref);
    await cdp(tab.id, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
    await cdp(tab.id, "DOM.focus", { backendNodeId });
  }
  await cdp(tab.id, "Input.insertText", { text: params.text });
  return `Typed ${params.text.length} characters.`;
}

interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};
for (let i = 1; i <= 12; i++) NAMED_KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

/** Editing shortcuts don't run from synthetic key events on macOS; CDP needs explicit commands. */
const EDIT_COMMANDS: Record<string, string> = {
  a: "selectAll",
  c: "copy",
  x: "cut",
  v: "paste",
  z: "undo",
};

function keyDef(name: string, shift: boolean): KeyDef {
  const named = NAMED_KEYS[name.toLowerCase()];
  if (named) return named;
  if ([...name].length !== 1) throw new BridgeError("BAD_REQUEST", `Unknown key "${name}"`);
  const upper = name.toUpperCase();
  const code = /[a-z]/i.test(name) ? `Key${upper}` : /\d/.test(name) ? `Digit${name}` : "";
  const keyCode = /[a-z\d]/i.test(name) ? upper.charCodeAt(0) : 0;
  const char = shift ? upper : name;
  return { key: char, code, keyCode, text: char };
}

async function pressChord(tabId: number, chord: string): Promise<void> {
  const parts = chord.split("+").filter(Boolean);
  const keyName = parts.pop();
  if (!keyName) throw new BridgeError("BAD_REQUEST", `Empty key in "${chord}"`);
  const modifiers = modifierMask(parts.join("+"));
  const shift = (modifiers & 8) !== 0;
  const def = keyDef(keyName, shift);
  const commandKey = (modifiers & 6) !== 0 ? EDIT_COMMANDS[keyName.toLowerCase()] : undefined;
  const commands = commandKey ? [shift && commandKey === "undo" ? "redo" : commandKey] : undefined;
  // Text is only produced without ctrl/meta/alt, matching real keyboards.
  const text = modifiers & 7 ? undefined : def.text;
  const base = {
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers,
  };
  await cdp(tabId, "Input.dispatchKeyEvent", {
    ...base,
    type: text ? "keyDown" : "rawKeyDown",
    text,
    unmodifiedText: text,
    commands,
  });
  await cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

export async function key(params: Params, ctx: Context) {
  if (typeof params.keys !== "string" || !params.keys.trim()) throw new BridgeError("BAD_REQUEST", "keys is required");
  const tab = await resolveTab(ctx.session, params.tabId);
  const chords = params.keys.trim().split(/\s+/);
  const repeat = typeof params.repeat === "number" ? params.repeat : 1;
  for (let r = 0; r < repeat; r++) {
    for (const chord of chords) await pressChord(tab.id, chord);
  }
  return `Pressed ${params.keys}${repeat > 1 ? ` ×${repeat}` : ""}.`;
}

export async function scroll(params: Params, ctx: Context) {
  const tab = await resolveTab(ctx.session, params.tabId);
  const point = await resolvePoint(tab.id, params, true);
  const distance = (typeof params.amount === "number" ? params.amount : 3) * 100;
  const deltas: Record<string, [number, number]> = {
    up: [0, -distance],
    down: [0, distance],
    left: [-distance, 0],
    right: [distance, 0],
  };
  const delta = deltas[params.direction];
  if (!delta) throw new BridgeError("BAD_REQUEST", "direction must be up, down, left or right");
  await mouse(tab.id, { type: "mouseWheel", ...point, deltaX: delta[0], deltaY: delta[1] });
  // Give smooth scrolling a moment before reporting the new position.
  await new Promise((r) => setTimeout(r, 150));
  const vp = await viewport(tab.id);
  return `Scrolled ${params.direction}. Page offset now (${Math.round(vp.pageX)}, ${Math.round(vp.pageY)}).`;
}
