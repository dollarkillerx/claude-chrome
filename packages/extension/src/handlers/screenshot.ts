import { BridgeError, type ScreenshotResult } from "@claude-chrome/protocol";
import { cdp } from "../cdp";
import type { Context, Params } from "../dispatcher";
import { evaluateIsolated, hideBlockedFrames, listFrames, viewport, type Viewport } from "../frames";
import { resolveTab } from "../tabs";
import { elementBox } from "./input";

/** Full-page captures are capped so the image stays usable for the model. */
const MAX_FULL_PAGE_HEIGHT = 16_000;
const CAPTURE_TIMEOUT_MS = 8_000;
/** Time for lazy content and scroll-linked effects to settle between full-page slices. */
const SLICE_SETTLE_MS = 120;

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Captures without activating the tab: Chrome renders a frame on demand even for background tabs,
 * so the user's visible tab never changes. Falls back to activating only if that times out.
 */
async function capture(
  tabId: number,
  params: { format: "png" | "jpeg"; clip: Clip; scale: number; beyondViewport?: boolean },
): Promise<string> {
  const run = () =>
    cdp<{ data: string }>(tabId, "Page.captureScreenshot", {
      format: params.format,
      ...(params.format === "jpeg" ? { quality: 80 } : {}),
      clip: { ...params.clip, scale: params.scale },
      captureBeyondViewport: Boolean(params.beyondViewport),
    }).then((r) => r.data);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BridgeError("TIMEOUT", "capture timed out")), CAPTURE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(), timeout]);
  } catch (error) {
    if (!(error instanceof BridgeError && error.code === "TIMEOUT")) throw error;
    await chrome.tabs.update(tabId, { active: true });
    return run();
  } finally {
    clearTimeout(timer);
  }
}

async function base64ToBitmap(data: string): Promise<ImageBitmap> {
  const blob = await (await fetch(`data:image/png;base64,${data}`)).blob();
  return createImageBitmap(blob);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const HIDE_FIXED = `(() => {
  for (const el of document.querySelectorAll("body *")) {
    const p = getComputedStyle(el).position;
    if (p !== "fixed" && p !== "sticky") continue;
    el.setAttribute("data-claude-chrome-hidden", el.style.getPropertyValue("visibility"));
    el.style.setProperty("visibility", "hidden", "important");
  }
})()`;
const RESTORE_FIXED = `(() => {
  for (const el of document.querySelectorAll("[data-claude-chrome-hidden]")) {
    const previous = el.getAttribute("data-claude-chrome-hidden");
    if (previous) el.style.setProperty("visibility", previous); else el.style.removeProperty("visibility");
    el.removeAttribute("data-claude-chrome-hidden");
  }
})()`;
// Overlay scrollbars flash in while we scroll and would be baked into every slice.
const HIDE_SCROLLBARS = `(() => {
  const style = document.createElement("style");
  style.id = "claude-chrome-no-scrollbars";
  style.textContent = "html { scrollbar-width: none !important } ::-webkit-scrollbar { display: none !important }";
  document.documentElement.appendChild(style);
})()`;
const RESTORE_SCROLLBARS = `document.getElementById("claude-chrome-no-scrollbars")?.remove()`;
const SLICE_STATE = `({ x: visualViewport ? visualViewport.pageLeft : scrollX, y: visualViewport ? visualViewport.pageTop : scrollY,
  width: innerWidth, height: innerHeight, dpr: devicePixelRatio, docHeight: document.documentElement.scrollHeight })`;

interface SliceState {
  x: number;
  y: number;
  width: number;
  height: number;
  dpr: number;
  docHeight: number;
}

/**
 * Scrolls through the page and stitches viewport-sized slices. Unlike enlarging the viewport
 * (captureBeyondViewport), this keeps 100vh sections at their real height. Fixed and sticky
 * elements are hidden after the first slice so headers don't repeat down the image. Every slice
 * re-reads the viewport, because it can change mid-capture (e.g. Chrome's debugging infobar).
 */
async function fullPage(tabId: number, vp: Viewport, format: "png" | "jpeg") {
  const slices: Array<{ bitmap: ImageBitmap; y: number }> = [];
  let covered = 0;
  let docHeight = 0;
  let hidFixed = false;
  await evaluateIsolated(tabId, HIDE_SCROLLBARS);
  try {
    for (let target = 0; ; ) {
      await evaluateIsolated(tabId, `window.scrollTo({ left: 0, top: ${target}, behavior: "instant" })`);
      await sleep(SLICE_SETTLE_MS);
      const now = (await evaluateIsolated(tabId, SLICE_STATE)) as SliceState;
      docHeight = Math.min(now.docHeight, MAX_FULL_PAGE_HEIGHT);
      if (slices.length > 0 && now.y + now.height <= covered) break; // page stopped scrolling
      const data = await capture(tabId, {
        format: "png",
        clip: { x: now.x, y: now.y, width: now.width, height: now.height },
        scale: 1 / now.dpr,
      });
      slices.push({ bitmap: await base64ToBitmap(data), y: Math.round(now.y) });
      covered = now.y + now.height;
      target = covered;
      if (!hidFixed) {
        await evaluateIsolated(tabId, HIDE_FIXED);
        hidFixed = true;
      }
      if (covered >= docHeight) break;
    }
  } finally {
    if (hidFixed) await evaluateIsolated(tabId, RESTORE_FIXED).catch(() => {});
    await evaluateIsolated(tabId, RESTORE_SCROLLBARS).catch(() => {});
    await evaluateIsolated(tabId, `window.scrollTo({ left: ${vp.pageX}, top: ${vp.pageY}, behavior: "instant" })`).catch(
      () => {},
    );
  }
  const width = Math.max(...slices.map((s) => s.bitmap.width));
  const height = Math.min(Math.round(covered), docHeight || Math.round(covered));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (!context) throw new BridgeError("INTERNAL", "Canvas unavailable");
  for (const slice of slices) context.drawImage(slice.bitmap, 0, slice.y);
  const blob = await canvas.convertToBlob({ type: `image/${format}`, quality: 0.8 });
  const truncated = docHeight >= MAX_FULL_PAGE_HEIGHT;
  return {
    data: await blobToBase64(blob),
    width,
    height,
    note:
      `Full page ${width}x${height} CSS px` +
      (truncated ? ` (truncated at ${MAX_FULL_PAGE_HEIGHT})` : "") +
      ". Image y = page y; subtract the scroll offset before using coordinates with click.",
  };
}

export async function screenshot({ tabId, format, fullPage: wantFullPage, ref }: Params, ctx: Context): Promise<ScreenshotResult> {
  const tab = await resolveTab(ctx.session, tabId);
  const fmt = format === "png" ? "png" : "jpeg";
  // Blocked frames must not show up in the image either.
  const restoreFrames = await hideBlockedFrames(tab.id, await listFrames(tab.id));
  try {
    if (wantFullPage && typeof ref !== "string") {
      const result = await fullPage(tab.id, await viewport(tab.id), fmt);
      return { mimeType: `image/${fmt}`, ...result };
    }

    let clip: Clip;
    let note: string | undefined;
    let beyondViewport = false;
    if (typeof ref === "string") {
      const box = await elementBox(tab.id, ref); // also scrolls it into view
      const vp = await viewport(tab.id);
      // The box is viewport-relative; the clip is document-relative.
      clip = { x: box.x + vp.pageX, y: box.y + vp.pageY, width: Math.max(1, box.width), height: Math.max(1, box.height) };
      beyondViewport = box.width > vp.width || box.height > vp.height;
      note = `Element ${ref}: ${Math.round(clip.width)}x${Math.round(clip.height)} CSS px. Coordinates in this image are NOT viewport coordinates; click by ref instead.`;
    } else {
      const vp = await viewport(tab.id);
      clip = { x: vp.pageX, y: vp.pageY, width: vp.width, height: vp.height };
    }
    const vp = await viewport(tab.id);
    // Scale by 1/dpr so image pixels == CSS pixels (== Input.dispatchMouseEvent coordinates for viewport shots).
    const data = await capture(tab.id, { format: fmt, clip, scale: 1 / vp.dpr, beyondViewport });
    return { mimeType: `image/${fmt}`, data, width: Math.round(clip.width), height: Math.round(clip.height), note };
  } finally {
    await restoreFrames();
  }
}
