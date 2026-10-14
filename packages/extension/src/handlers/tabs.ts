import { BridgeError } from "@claude-chrome/protocol";
import { attachedTabs } from "../cdp";
import type { Context, Params } from "../dispatcher";
import { checkUrl, normalizeUrl } from "../policy";
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
  return tabs.map((tab) => ({
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title,
    url: tab.url || tab.pendingUrl,
    active: tab.active,
    current: tab.id === session.currentTabId,
    owner: tab.id === undefined ? null : owner(tab.id),
  }));
}

export async function tabsCreate({ url }: Params, ctx: Context) {
  const target = url ? normalizeUrl(String(url)) : "about:blank";
  await checkUrl(target);
  // Open blank first so we can listen for the load before navigating.
  const tab = await openSessionTab(ctx.session);
  let loaded = true;
  if (target !== "about:blank") {
    const done = waitForLoad(tab.id);
    await chrome.tabs.update(tab.id, { url: target });
    loaded = await done;
  }
  return describe(tab.id, loaded);
}

export async function tabsSelect({ tabId, takeOver }: Params, ctx: Context) {
  if (typeof tabId !== "number") throw new BridgeError("BAD_REQUEST", "tabId is required");
  // Ownership is checked inside selectTab (with takeOver); policy and existence here.
  await selectTab(ctx.session, tabId, takeOver === true);
  const tab = await resolveTab(ctx.session, tabId);
  await chrome.tabs.update(tab.id, { active: true });
  return describe(tab.id, true);
}

export async function tabsClose({ tabId }: Params, ctx: Context) {
  const tab = await resolveTab(ctx.session, tabId);
  await chrome.tabs.remove(tab.id);
  return { closed: tab.id };
}

export async function navigate({ url, tabId }: Params, ctx: Context) {
  if (typeof url !== "string" || !url) throw new BridgeError("BAD_REQUEST", "url is required");
  const tab = await resolveTab(ctx.session, tabId);
  const done = waitForLoad(tab.id);
  if (url === "back") await chrome.tabs.goBack(tab.id);
  else if (url === "forward") await chrome.tabs.goForward(tab.id);
  else {
    const target = normalizeUrl(url);
    await checkUrl(target);
    await chrome.tabs.update(tab.id, { url: target });
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
