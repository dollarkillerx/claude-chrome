import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { uploadPolicyFromEnv, validateUploadPaths } from "../src/uploads.js";

const dir = mkdtempSync(join(tmpdir(), "uploads-test-"));
const file = join(dir, "report.pdf");
writeFileSync(file, "pdf");
writeFileSync(join(dir, ".env"), "SECRET=1");
mkdirSync(join(dir, "sub"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const open = { allowedDirs: [] };

describe("validateUploadPaths", () => {
  it("returns canonical paths for normal files", () => {
    const [path] = validateUploadPaths([file], open);
    expect(path.endsWith("report.pdf")).toBe(true);
  });

  it("rejects relative, missing and non-file paths", () => {
    expect(() => validateUploadPaths(["report.pdf"], open)).toThrow(/absolute/);
    expect(() => validateUploadPaths([join(dir, "nope.txt")], open)).toThrow(/not found/);
    expect(() => validateUploadPaths([join(dir, "sub")], open)).toThrow(/regular file/);
    expect(() => validateUploadPaths([], open)).toThrow(/non-empty/);
  });

  it("refuses secret files, also through symlinks", () => {
    expect(() => validateUploadPaths([join(dir, ".env")], open)).toThrow(/not allowed/);
    const link = join(dir, "innocent.txt");
    symlinkSync(join(dir, ".env"), link);
    expect(() => validateUploadPaths([link], open)).toThrow(/not allowed/);
  });

  it("refuses ~/.ssh", () => {
    // Only meaningful if the file exists; the check runs after resolving the path.
    const key = join(homedir(), ".ssh", "known_hosts");
    try {
      validateUploadPaths([key], open);
      throw new Error("should have thrown");
    } catch (error) {
      expect(String(error)).toMatch(/not allowed|not found/);
    }
  });

  it("enforces CLAUDE_CHROME_UPLOAD_DIRS", () => {
    const policy = uploadPolicyFromEnv({ CLAUDE_CHROME_UPLOAD_DIRS: join(dir, "sub") });
    expect(() => validateUploadPaths([file], policy)).toThrow(/outside/);
    expect(validateUploadPaths([file], uploadPolicyFromEnv({ CLAUDE_CHROME_UPLOAD_DIRS: dir }))).toHaveLength(1);
  });
});
