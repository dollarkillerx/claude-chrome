import {
  constants,
  createReadStream,
  createWriteStream,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
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

const SNAPSHOT_PREFIX = "claude-chrome-upload-";
/** Chrome reads the file lazily (when the page submits it), so snapshots must outlive the call. */
const SNAPSHOT_TTL_MS = 2 * 60 * 60 * 1000;
const snapshotDirs = new Set<string>();

/**
 * Closes the check-then-use gap: re-resolves each validated path, opens it without following a final
 * symlink, verifies the open file is the one that passed validation, and copies it into a private
 * temp dir. The browser then reads the copy, so swapping a symlink or parent directory after
 * validation can't redirect the upload to a different file.
 */
export async function snapshotUploads(validated: string[], policy: UploadPolicy): Promise<string[]> {
  pruneSnapshots();
  const dir = mkdtempSync(join(tmpdir(), SNAPSHOT_PREFIX)); // mode 0700
  snapshotDirs.add(dir);
  try {
    return await Promise.all(
      validated.map(async (path, index) => {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const opened = fstatSync(fd);
        // Re-validate *after* opening, then require the open file to be that same inode.
        const [again] = validateUploadPaths([path], policy);
        const current = statSync(again);
        if (!opened.isFile() || opened.ino !== current.ino || opened.dev !== current.dev) {
          throw new BridgeError("BLOCKED_BY_POLICY", `${path} changed while it was being uploaded; try again.`);
        }
        // Index prefix keeps same-named files from different folders apart; the page sees the base name.
        mkdirSync(join(dir, String(index)), { mode: 0o700 });
        const target = join(dir, String(index), basename(path));
        await pipeline(createReadStream("", { fd }), createWriteStream(target, { mode: 0o600 }));
        return target;
      }),
    );
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    snapshotDirs.delete(dir);
    throw error instanceof BridgeError ? error : new BridgeError("BAD_REQUEST", (error as Error).message);
  }
}

/** Removes snapshot dirs older than the TTL (including ones left behind by crashed processes). */
function pruneSnapshots(): void {
  const base = tmpdir();
  let entries: string[] = [];
  try {
    entries = readdirSync(base).filter((name) => name.startsWith(SNAPSHOT_PREFIX));
  } catch {
    return;
  }
  for (const name of entries) {
    const dir = join(base, name);
    try {
      if (Date.now() - statSync(dir).mtimeMs > SNAPSHOT_TTL_MS) rmSync(dir, { recursive: true, force: true });
    } catch {
      // Raced with another process cleaning up; ignore.
    }
  }
}

/** Called on shutdown: this process's snapshots are no longer needed once its session ends. */
export function removeSnapshots(): void {
  for (const dir of snapshotDirs) rmSync(dir, { recursive: true, force: true });
  snapshotDirs.clear();
}
