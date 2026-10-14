import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = process.env.CLAUDE_CHROME_HOME ?? join(homedir(), ".claude-chrome");
export const TOKEN_PATH = join(CONFIG_DIR, "token");

/** Reads the pairing token, generating one on first run. Shared by hub and peers. */
export function loadOrCreateToken(): string {
  if (process.env.CLAUDE_CHROME_TOKEN) return process.env.CLAUDE_CHROME_TOKEN;
  if (existsSync(TOKEN_PATH)) {
    const token = readFileSync(TOKEN_PATH, "utf8").trim();
    if (token) return token;
  }
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const token = randomBytes(24).toString("base64url");
  writeFileSync(TOKEN_PATH, token + "\n", { mode: 0o600 });
  chmodSync(TOKEN_PATH, 0o600);
  return token;
}

/** Constant-time string comparison. */
export function tokensEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
