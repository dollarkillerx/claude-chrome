import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { BridgeError } from "@claude-chrome/protocol";
import { CONFIG_DIR } from "./token.js";

/** Common credential stores under $HOME that should never leave the machine through a web form. */
const DENIED_SEGMENTS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".azure",
  ".config/gcloud",
  ".config/gh",
  ".claude",
  "Library/Keychains",
  "Library/Application Support/Google/Chrome",
  "Library/Cookies",
];
/** Matched case-insensitively against the file name, anywhere on disk. */
const DENIED_NAMES = [
  /^\.env(\..*)?$/,
  /^\.netrc$/,
  /^\.npmrc$/,
  /^\.pypirc$/,
  /^\.git-credentials$/,
  /^\.(bash|zsh|python)_history$/,
  /^id_(rsa|ed25519|ecdsa|dsa)/,
  /\.(pem|key|p12|pfx|keychain)$/,
];
/** macOS and Windows file systems are case-insensitive by default, so compare case-folded paths there. */
const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";
const fold = (path: string) => (CASE_INSENSITIVE ? path.toLowerCase() : path);
const MAX_FILE_BYTES = 200 * 1024 * 1024;

export interface UploadPolicy {
  /** If non-empty, files must live under one of these directories. */
  allowedDirs: string[];
}

export function uploadPolicyFromEnv(env = process.env): UploadPolicy {
  const raw = env.CLAUDE_CHROME_UPLOAD_DIRS ?? "";
  return {
    allowedDirs: raw
      .split(":")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => realpathOrSelf(resolve(d.replace(/^~(?=$|\/)/, homedir())))),
  };
}

/** realpathSync.native also canonicalizes letter case (the JS version keeps the input's case). */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function within(path: string, dir: string): boolean {
  const p = fold(path);
  const d = fold(dir);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}

/**
 * Validates upload paths on the server side (the extension can't see the filesystem) and returns
 * canonical absolute paths. Symlinks are resolved before the checks so they can't smuggle in denied files.
 */
export function validateUploadPaths(paths: unknown, policy: UploadPolicy): string[] {
  if (!Array.isArray(paths) || paths.length === 0) throw new BridgeError("BAD_REQUEST", "paths must be a non-empty array");
  const home = realpathOrSelf(homedir());
  return paths.map((input) => {
    if (typeof input !== "string" || !input) throw new BridgeError("BAD_REQUEST", "Each path must be a string");
    const expanded = input.replace(/^~(?=$|\/)/, homedir());
    if (!isAbsolute(expanded)) throw new BridgeError("BAD_REQUEST", `Path must be absolute: ${input}`);
    let real: string;
    try {
      real = realpathSync.native(expanded);
    } catch {
      throw new BridgeError("BAD_REQUEST", `File not found: ${input}`);
    }
    const stat = statSync(real);
    if (!stat.isFile()) throw new BridgeError("BAD_REQUEST", `Not a regular file: ${input}`);
    if (stat.size > MAX_FILE_BYTES) throw new BridgeError("BAD_REQUEST", `File larger than 200 MB: ${input}`);

    const relToHome = within(real, home) ? real.slice(home.length + 1) : null;
    const name = (real.split(sep).pop() ?? "").toLowerCase();
    const denied =
      within(real, realpathOrSelf(CONFIG_DIR)) ||
      DENIED_NAMES.some((re) => re.test(name)) ||
      (relToHome !== null && DENIED_SEGMENTS.some((seg) => within(relToHome, seg)));
    if (denied) throw new BridgeError("BLOCKED_BY_POLICY", `Uploading ${input} is not allowed (credential/secret file).`);

    if (policy.allowedDirs.length > 0 && !policy.allowedDirs.some((dir) => within(real, dir))) {
      throw new BridgeError(
        "BLOCKED_BY_POLICY",
        `${input} is outside CLAUDE_CHROME_UPLOAD_DIRS (${policy.allowedDirs.join(", ")}).`,
      );
    }
    return real;
  });
}
