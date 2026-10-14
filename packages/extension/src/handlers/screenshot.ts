import { BridgeError, type ScreenshotResult } from "@claude-chrome/protocol";
import { cdp } from "../cdp";
import type { Context, Params } from "../dispatcher";
import { resolveTab } from "../tabs";
import { backendIdForRef } from "./accessibility";
import { evaluate } from "./page";

interface Viewport {
  width: number;
  height: number;
  dpr: number;
  pageX: number;
  pageY: number;
}

/** Full-page captures are capped so the image stays usable for the model. */
const MAX_FULL_PAGE_HEIGHT = 16_000;

export async function viewport(tabId: number): Promise<Viewport> {
  return evaluate(
    tabId,
    `({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
        pageX: visualViewport ? visualViewport.pageLeft : scrollX,
        pageY: visualViewport ? visualViewport.pageTop : scrollY })`,
  ) as Promise<Viewport>;
}

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function screenshot({ tabId, format, fullPage, ref }: Params, ctx: Context): Promise<ScreenshotResult> {
  const tab = await resolveTab(ctx.session, tabId);
  // Background tabs aren't rendered, so capturing them can hang. Each session has its own
  // window, so activating the tab doesn't disturb other sessions.
  if (!tab.active) await chrome.tabs.update(tab.id, { active: true });

  const vp = await viewport(tab.id);
  const fmt = format === "png" ? "png" : "jpeg";
  let clip: Clip;
  let note: string | undefined;

  if (typeof ref === "string") {
    const backendNodeId = backendIdForRef(tab.id, ref);
    await cdp(tab.id, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(() => {});
    const { model } = await cdp<{ model: { border: number[] } }>(tab.id, "DOM.getBoxModel", { backendNodeId });
    const xs = [model.border[0], model.border[2], model.border[4], model.border[6]];
    const ys = [model.border[1], model.border[3], model.border[5], model.border[7]];
    // Box model is viewport-relative; the clip is document-relative.
    const after = await viewport(tab.id);
    clip = {
      x: Math.min(...xs) + after.pageX,
      y: Math.min(...ys) + after.pageY,
      width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
      height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
    };
    note = `Element ${ref}: ${Math.round(clip.width)}x${Math.round(clip.height)} CSS px. Coordinates in this image are NOT viewport coordinates; click by ref instead.`;
  } else if (fullPage) {
    const metrics = await cdp<{ cssContentSize: { width: number; height: number } }>(tab.id, "Page.getLayoutMetrics");
    const { width, height } = metrics.cssContentSize;
    const capped = Math.min(height, MAX_FULL_PAGE_HEIGHT);
    clip = { x: 0, y: 0, width: Math.max(width, vp.width), height: capped };
    note =
      `Full page ${Math.round(clip.width)}x${Math.round(capped)} CSS px` +
      (capped < height ? ` (truncated from ${Math.round(height)})` : "") +
      ". Image y = page y; subtract the scroll offset before using coordinates with click.";
  } else {
    clip = { x: vp.pageX, y: vp.pageY, width: vp.width, height: vp.height };
  }

  if (clip.width * clip.height === 0) throw new BridgeError("BAD_REQUEST", "Nothing to capture (zero-size area).");
  // Scale by 1/dpr so image pixels == CSS pixels (== Input.dispatchMouseEvent coordinates for viewport shots).
  const { data } = await cdp<{ data: string }>(tab.id, "Page.captureScreenshot", {
    format: fmt,
    ...(fmt === "jpeg" ? { quality: 80 } : {}),
    clip: { ...clip, scale: 1 / vp.dpr },
    captureBeyondViewport: Boolean(fullPage || ref),
  });
  return { mimeType: `image/${fmt}`, data, width: Math.round(clip.width), height: Math.round(clip.height), note };
}
