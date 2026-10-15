import { BridgeError } from "@claude-chrome/protocol";
import { getSettings } from "./settings";

// file: is deliberately excluded: reading local files via get_page_text would bypass the
// server's upload denylist (e.g. file:///Users/me/.ssh/id_rsa).
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "data:", "blob:"]);

/** Hosts that are always off-limits (Chrome also refuses to debug the Web Store). */
const ALWAYS_BLOCKED_HOSTS = ["chromewebstore.google.com", "chrome.google.com"];

function hostMatches(host: string, pattern: string): boolean {
  // Accept entries pasted as URLs ("https://bank.example/login") as well as bare hosts.
  const p = pattern
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/:?#].*$/, "")
    .replace(/^\*\./, "");
  return p !== "" && (host === p || host.endsWith("." + p));
}

/** Throws BLOCKED_BY_POLICY if Claude must not operate on `url`. */
export async function checkUrl(url: string | undefined): Promise<void> {
  // about:srcdoc only occurs for iframes, whose embedding page was already checked.
  if (!url || url === "about:blank" || url === "about:srcdoc") return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BridgeError("BAD_REQUEST", `Invalid URL: ${url}`);
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new BridgeError("BLOCKED_BY_POLICY", `${parsed.protocol}// pages cannot be controlled`);
  }
  // blob:https://site/uuid inherits the creating site's host.
  let host = parsed.hostname.toLowerCase();
  if (parsed.protocol === "blob:") {
    try {
      host = new URL(url.slice("blob:".length)).hostname.toLowerCase();
    } catch {
      host = "";
    }
  }
  const { blockedHosts } = await getSettings();
  const hit = [...ALWAYS_BLOCKED_HOSTS, ...blockedHosts].find((p) => hostMatches(host, p));
  if (hit) {
    throw new BridgeError("BLOCKED_BY_POLICY", `${host} is blocked in the extension settings`);
  }
}

/** Non-throwing variant, e.g. to redact blocked tabs in tabs_list. */
export async function isAllowed(url: string | undefined): Promise<boolean> {
  return checkUrl(url).then(
    () => true,
    () => false,
  );
}

const SCHEMELESS_URL_PROTOCOLS = /^(about|data|blob|javascript|view-source|mailto|chrome|devtools|file):/i;
const LOCAL_HOST = /^(localhost|127(\.\d+){3}|\[::1\]|0\.0\.0\.0)(:\d+)?([/?#]|$)/i;

/**
 * Adds a scheme when missing: http:// for local dev hosts ("localhost:3000" must not be read as a
 * "localhost:" scheme), https:// for everything else.
 */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || SCHEMELESS_URL_PROTOCOLS.test(trimmed)) return trimmed;
  return (LOCAL_HOST.test(trimmed) ? "http://" : "https://") + trimmed;
}
