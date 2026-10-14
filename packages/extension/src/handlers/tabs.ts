import { BridgeError } from "@claude-chrome/protocol";
import { attachedTabs } from "../cdp";
import type { Context, Params } from "../dispatcher";
import { checkUrl, isAllowed, normalizeUrl } from "../policy";
import { getSettings } from "../settings";
import { getSession, openSessionTab, resolveTab, selectTab, tabOwners, waitForLoad } from "../tabs";

export async function status(_params: Params, ctx: Context) {
  const session = await getSession(ctx.session);
  const settings = await getSettings();
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    session: session.label,
    windowId: session.windowId ?? null,
    currentTabId: session.currentTabId ?? null,
    tabs: session.tabs,
    attachedTabs: attachedTabs(),
    blockedHosts: settings.blockedHosts,
  };
}

export async function tabsList(_params: Params, ctx: Context) {
  const session = await getSession(ctx.session);
  const owner = await tabOwners(ctx.session);
  const tabs = await chrome.tabs.query({});
  return Promise.all(
    tabs.map(async (tab) => {
      const url = tab.url || tab.pendingUrl;
      // Don't reveal what the user is doing on sites they blocked for Claude.
      const allowed = await isAllowed(url);
      return {
        tabId: tab.id,
        windowId: tab.windowId,
        title: allowed ? tab.title : "(blocked)",
        url: allowed ? url : "(blocked)",
        active: tab.active,
        current: tab.id === session.currentTabId,
        owner: tab.id === undefined ? null : owner(tab.id),
      };
    }),
  );
}

export async function tabsCreate({ url }: Params, ctx: Context) {
  const target = url ? normalizeUrl(String(url)) : "about:blank";
  await checkUrl(target);
  // Opening directly at the target avoids an about:blank "complete" event ending the wait early;
  // waitForLoad's status poll covers a load that finishes before the listener is armed.
  const tab = await openSessionTab(ctx.session, target);
  const loaded = target === "about:blank" ? true : await waitForLoad(tab.id);
  const result = await describe(tab.id, loaded);
  await checkUrl(result.url); // redirects can land on a blocked site
  return result;
}

export async function tabsSelect({ tabId, takeOver }: Params, ctx: Context) {
  if (typeof tabId !== "number") throw new BridgeError("BAD_REQUEST", "tabId is required");
  // Validate before changing any ownership state.
  const tab = await chrome.tabs.get(tabId).catch(() => {
    throw new BridgeError("TAB_NOT_FOUND", `Tab ${tabId} does not exist (it may have been closed).`);
  });
  await checkUrl(tab.url || tab.pendingUrl);
  await selectTab(ctx.session, tabId, takeOver === true);
  await chrome.tabs.update(tabId, { active: true });
  return describe(tabId, true);
}

export async function tabsClose({ tabId }: Params, ctx: Context) {
  // No policy check: closing must work even if the tab ended up on a blocked page.
  const tab = await resolveTab(ctx.session, tabId, { skipPolicy: true });
  await chrome.tabs.remove(tab.id);
  return { closed: tab.id };
}

export async function navigate({ url, tabId }: Params, ctx: Context) {
  if (typeof url !== "string" || !url) throw new BridgeError("BAD_REQUEST", "url is required");
  // The current page may be blocked (e.g. after a redirect); leaving it must still be possible.
  const tab = await resolveTab(ctx.session, tabId, { skipPolicy: true });
  const target = url === "back" || url === "forward" ? null : normalizeUrl(url);
  if (target) await checkUrl(target);
  const done = waitForLoad(tab.id);
  try {
    if (url === "back") await chrome.tabs.goBack(tab.id);
    else if (url === "forward") await chrome.tabs.goForward(tab.id);
    else await chrome.tabs.update(tab.id, { url: target! });
  } catch (error) {
    done.cancel();
    throw error;
  }
  const loaded = await done;
  const result = await describe(tab.id, loaded);
  // Redirects can land on a blocked site; refuse to continue there.
  await checkUrl(result.url);
  return result;
}

async function describe(tabId: number, loaded: boolean) {
  const tab = await chrome.tabs.get(tabId);
  return {
    tabId,
    url: tab.url || tab.pendingUrl || "",
    title: tab.title ?? "",
    ...(loaded ? {} : { note: "Page is still loading (timed out waiting for load)." }),
  };
}
