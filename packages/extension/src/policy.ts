import { BridgeError } from "@claude-chrome/protocol";
import { getSettings } from "./settings";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "file:", "data:"]);

/** Hosts that are always off-limits (Chrome also refuses to debug the Web Store). */
const ALWAYS_BLOCKED_HOSTS = ["chromewebstore.google.com", "chrome.google.com"];

function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase().replace(/^\*\./, "");
  return p !== "" && (host === p || host.endsWith("." + p));
}

/** Throws BLOCKED_BY_POLICY if Claude must not operate on `url`. */
export async function checkUrl(url: string | undefined): Promise<void> {
  if (!url || url === "about:blank") return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BridgeError("BAD_REQUEST", `Invalid URL: ${url}`);
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new BridgeError("BLOCKED_BY_POLICY", `${parsed.protocol}// pages cannot be controlled`);
  }
  const host = parsed.hostname.toLowerCase();
  const { blockedHosts } = await getSettings();
  const hit = [...ALWAYS_BLOCKED_HOSTS, ...blockedHosts].find((p) => hostMatches(host, p));
  if (hit) {
    throw new BridgeError("BLOCKED_BY_POLICY", `${host} is blocked in the extension settings`);
  }
}

/** Adds https:// when the URL has no scheme. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return "https://" + trimmed;
}
