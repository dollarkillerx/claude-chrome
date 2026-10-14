import { BridgeError } from "@claude-chrome/protocol";
import { cdp, clearConsole, ensureAttached, readConsole } from "../cdp";
import { resolveTab } from "../tabs";
import type { Context, Params } from "../dispatcher";

interface EvaluateResponse {
  result: { type: string; value?: unknown; description?: string; unserializableValue?: string };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

/** Below the hub's 30s timeout so the model gets a precise error instead of a generic one. */
const EVAL_TIMEOUT_MS = 25_000;

/**
 * Runtime.evaluate with REPL semantics; throws JS_EXCEPTION if the code throws.
 * `userGesture` is only granted for model-authored code (eval_js), not for internal reads.
 */
export async function evaluate(tabId: number, expression: string, { userGesture = false } = {}): Promise<unknown> {
  const response = await cdp<EvaluateResponse>(tabId, "Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    replMode: true,
    userGesture,
    timeout: EVAL_TIMEOUT_MS, // bounds synchronous execution
  });
  if (response.exceptionDetails) {
    const details = response.exceptionDetails;
    throw new BridgeError("JS_EXCEPTION", details.exception?.description ?? details.text);
  }
  const { result } = response;
  if (result.type === "undefined") return undefined;
  if (result.value !== undefined) return result.value;
  return result.unserializableValue ?? result.description ?? result.type;
}

export async function evalJs({ code, tabId }: Params, ctx: Context) {
  if (typeof code !== "string") throw new BridgeError("BAD_REQUEST", "code is required");
  const tab = await resolveTab(ctx.session, tabId);
  // Runtime.evaluate's timeout doesn't cover awaited promises, so race those separately.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const value = await Promise.race([
    evaluate(tab.id, code, { userGesture: true }),
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new BridgeError("TIMEOUT", `eval_js did not finish within ${EVAL_TIMEOUT_MS / 1000}s`)),
        EVAL_TIMEOUT_MS,
      );
    }),
  ]).catch((error) => {
    // Chrome garbage-collects never-settling promises and reports it as an error.
    if (/Promise was collected/.test(String(error?.message))) {
      throw new BridgeError("TIMEOUT", "eval_js awaited a promise that never settled");
    }
    throw error;
  }).finally(() => clearTimeout(timer));
  // Always JSON-encode so an empty string ("") is distinguishable from no output.
  return value === undefined ? "undefined" : JSON.stringify(value, null, 2);
}

const PAGE_TEXT_SCRIPT = `(() => {
  const main = document.querySelector("article, main, [role=main]");
  const source = main && main.innerText.trim().length > 200 ? main : document.body;
  return { title: document.title, url: location.href, text: source ? source.innerText : "" };
})()`;

export async function getPageText({ tabId, maxChars }: Params, ctx: Context) {
  const tab = await resolveTab(ctx.session, tabId);
  const page = (await evaluate(tab.id, PAGE_TEXT_SCRIPT)) as { title: string; url: string; text: string };
  const limit = typeof maxChars === "number" ? maxChars : 50_000;
  const text = page.text.replace(/\n{3,}/g, "\n\n").trim();
  const truncated = text.length > limit;
  return `Title: ${page.title}\nURL: ${page.url}\n\n${truncated ? text.slice(0, limit) + "\n…[truncated]" : text}`;
}

export async function consoleLogs({ tabId, onlyErrors, pattern, limit, clear }: Params, ctx: Context) {
  const tab = await resolveTab(ctx.session, tabId);
  // Attaching starts capture; messages logged before that are not available.
  await ensureAttached(tab.id);
  let entries = readConsole(tab.id);
  if (onlyErrors) entries = entries.filter((e) => e.level === "error" || e.level === "exception");
  if (typeof pattern === "string" && pattern) {
    const needle = pattern.toLowerCase();
    entries = entries.filter((e) => e.text.toLowerCase().includes(needle));
  }
  entries = entries.slice(-(typeof limit === "number" ? limit : 100));
  if (clear) clearConsole(tab.id);
  if (entries.length === 0) return "No console messages captured (capture starts when Claude first attaches to the tab).";
  return entries.map((e) => `[${e.level}] ${e.text}${e.url ? `  (${e.url})` : ""}`).join("\n");
}
