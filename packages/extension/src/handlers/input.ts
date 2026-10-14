import { BridgeError } from "@claude-chrome/protocol";
import { cdp } from "../cdp";
import type { Context, Params } from "../dispatcher";
import { assertPointAllowed, listFrames, scrollFrameChainIntoView, sessionOffset, viewport } from "../frames";
import { resolveTab } from "../tabs";
import { resolveRef } from "./accessibility";

interface Point {
  x: number;
  y: number;
}

export interface Box extends Point {
  width: number;
  height: number;
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

/**
 * Scrolls a ref into view and returns its border box in main-viewport CSS pixels. Works for
 * elements inside iframes, including out-of-process ones (their coordinates are offset by the
 * position of each enclosing <iframe>).
 */
export async function elementBox(tabId: number, ref: string): Promise<Box> {
  const { backendNodeId, session } = resolveRef(tabId, ref);
  const docs = session ? await listFrames(tabId) : [];
  await scrollFrameChainIntoView(tabId, docs, session);
  await cdp(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId }, session).catch(() => {});
  const { quads } = await cdp<{ quads: number[][] }>(tabId, "DOM.getContentQuads", { backendNodeId }, session);
  const quad = quads?.[0];
  if (!quad) throw new BridgeError("REF_NOT_FOUND", `${ref} is not visible (no layout box).`);
  const offset = await sessionOffset(tabId, docs, session);
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  return {
    x: Math.min(...xs) + offset.x,
    y: Math.min(...ys) + offset.y,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/** Resolves a ref (scrolling it into view) or a coordinate to a main-viewport point in CSS pixels. */
async function resolvePoint(tabId: number, params: Params, fallbackToCenter = false): Promise<Point> {
  if (typeof params.ref === "string") {
    const box = await elementBox(tabId, params.ref);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  if (Array.isArray(params.coordinate) && params.coordinate.length === 2) {
    const [x, y] = params.coordinate.map(Number);
    // Refs only exist for allowed frames, but raw coordinates could land inside a blocked one.
    await assertPointAllowed(tabId, x, y, await listFrames(tabId));
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
    const { backendNodeId, session } = resolveRef(tab.id, params.ref);
    const docs = session ? await listFrames(tab.id) : [];
    await scrollFrameChainIntoView(tab.id, docs, session);
    await cdp(tab.id, "DOM.scrollIntoViewIfNeeded", { backendNodeId }, session).catch(() => {});
    await cdp(tab.id, "DOM.focus", { backendNodeId }, session);
  }
  // Input events go to the focused frame, so this also reaches elements inside iframes.
  await cdp(tab.id, "Input.insertText", { text: params.text });
  return `Typed ${params.text.length} characters.`;
}

// --- keyboard ---------------------------------------------------------------------------------

interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  /** The character itself requires Shift on a US layout (e.g. "!", "A"). */
  impliesShift?: boolean;
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
  plus: { key: "+", code: "Equal", keyCode: 187, text: "+", impliesShift: true },
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
  insert: { key: "Insert", code: "Insert", keyCode: 45 },
};
for (let i = 1; i <= 12; i++) NAMED_KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

/** Modifier keys pressed on their own (e.g. "shift" to trigger a keydown listener). */
const MODIFIER_KEYS: Record<string, KeyDef & { bit: number }> = {
  shift: { key: "Shift", code: "ShiftLeft", keyCode: 16, bit: 8 },
  ctrl: { key: "Control", code: "ControlLeft", keyCode: 17, bit: 2 },
  control: { key: "Control", code: "ControlLeft", keyCode: 17, bit: 2 },
  alt: { key: "Alt", code: "AltLeft", keyCode: 18, bit: 1 },
  option: { key: "Alt", code: "AltLeft", keyCode: 18, bit: 1 },
  meta: { key: "Meta", code: "MetaLeft", keyCode: 91, bit: 4 },
  cmd: { key: "Meta", code: "MetaLeft", keyCode: 91, bit: 4 },
  command: { key: "Meta", code: "MetaLeft", keyCode: 91, bit: 4 },
};

/** US layout: [unshifted, shifted, code, keyCode]. Letters are added below. */
const PRINTABLE: Array<[string, string, string, number]> = [
  ["`", "~", "Backquote", 192],
  ["1", "!", "Digit1", 49],
  ["2", "@", "Digit2", 50],
  ["3", "#", "Digit3", 51],
  ["4", "$", "Digit4", 52],
  ["5", "%", "Digit5", 53],
  ["6", "^", "Digit6", 54],
  ["7", "&", "Digit7", 55],
  ["8", "*", "Digit8", 56],
  ["9", "(", "Digit9", 57],
  ["0", ")", "Digit0", 48],
  ["-", "_", "Minus", 189],
  ["=", "+", "Equal", 187],
  ["[", "{", "BracketLeft", 219],
  ["]", "}", "BracketRight", 221],
  ["\\", "|", "Backslash", 220],
  [";", ":", "Semicolon", 186],
  ["'", '"', "Quote", 222],
  [",", "<", "Comma", 188],
  [".", ">", "Period", 190],
  ["/", "?", "Slash", 191],
];
for (let c = 97; c <= 122; c++) {
  const lower = String.fromCharCode(c);
  PRINTABLE.push([lower, lower.toUpperCase(), `Key${lower.toUpperCase()}`, c - 32]);
}
const BY_CHAR = new Map<string, { base: string; shifted: string; code: string; keyCode: number }>();
for (const [base, shifted, code, keyCode] of PRINTABLE) {
  const entry = { base, shifted, code, keyCode };
  BY_CHAR.set(base, entry);
  BY_CHAR.set(shifted, entry);
}

function keyDef(name: string, shiftHeld: boolean): KeyDef {
  const named = NAMED_KEYS[name.toLowerCase()];
  if (named) return named;
  if ([...name].length !== 1) throw new BridgeError("BAD_REQUEST", `Unknown key "${name}"`);
  const entry = BY_CHAR.get(name);
  if (!entry) return { key: name, code: "", keyCode: 0, text: name }; // non-US character, e.g. "é"
  const impliesShift = name === entry.shifted && entry.shifted !== entry.base;
  const char = shiftHeld || impliesShift ? entry.shifted : entry.base;
  return { key: char, code: entry.code, keyCode: entry.keyCode, text: char, impliesShift };
}

/** Editing shortcuts don't run from synthetic key events on macOS; CDP needs explicit commands there. */
const MAC_EDIT_COMMANDS: Record<string, string> = { a: "selectAll", c: "copy", x: "cut", v: "paste", z: "undo" };
const isMac = chrome.runtime.getPlatformInfo().then((info) => info.os === "mac");

/** Splits "ctrl+shift+a" into modifiers and key; a trailing "+" is the plus key itself ("ctrl++"). */
function parseChord(chord: string): { modifierNames: string[]; keyName: string } {
  if (chord === "+") return { modifierNames: [], keyName: "+" };
  if (chord.endsWith("++")) return { modifierNames: chord.slice(0, -2).split("+").filter(Boolean), keyName: "+" };
  const parts = chord.split("+");
  const keyName = parts.pop() ?? "";
  if (!keyName || parts.some((p) => !p)) throw new BridgeError("BAD_REQUEST", `Malformed key chord "${chord}"`);
  return { modifierNames: parts, keyName };
}

async function pressChord(tabId: number, chord: string): Promise<void> {
  const { modifierNames, keyName } = parseChord(chord);
  const lone = MODIFIER_KEYS[keyName.toLowerCase()];
  if (lone && modifierNames.length === 0) {
    const base = { key: lone.key, code: lone.code, windowsVirtualKeyCode: lone.keyCode, nativeVirtualKeyCode: lone.keyCode };
    await cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: "rawKeyDown", modifiers: lone.bit });
    await cdp(tabId, "Input.dispatchKeyEvent", { ...base, type: "keyUp", modifiers: 0 });
    return;
  }
  let modifiers = modifierMask(modifierNames.join("+"));
  const def = keyDef(keyName, (modifiers & 8) !== 0);
  if (def.impliesShift) modifiers |= 8;
  const shift = (modifiers & 8) !== 0;
  const commandKey = (await isMac) && modifiers & 4 ? MAC_EDIT_COMMANDS[def.key.toLowerCase()] : undefined;
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
