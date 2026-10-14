import { BridgeError } from "@claude-chrome/protocol";
import { getSettings } from "./settings";

// file: is deliberately excluded: reading local files via get_page_text would bypass the
// server's upload denylist (e.g. file:///Users/me/.ssh/id_rsa).
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "data:"]);

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

/** Non-throwing variant, e.g. to redact blocked tabs in tabs_list. */
export async function isAllowed(url: string | undefined): Promise<boolean> {
  return checkUrl(url).then(
    () => true,
    () => false,
  );
}

/** Adds https:// when the URL has no scheme. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return "https://" + trimmed;
}
