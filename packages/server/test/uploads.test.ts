import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { removeSnapshots, snapshotUploads, uploadPolicyFromEnv, validateUploadPaths } from "../src/uploads.js";

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

  it("refuses case variants on case-insensitive file systems", () => {
    if (process.platform !== "darwin" && process.platform !== "win32") return;
    expect(() => validateUploadPaths([join(dir, ".ENV")], open)).toThrow(/not allowed/);
  });

  it("refuses private keys and certificates by name", () => {
    writeFileSync(join(dir, "id_ed25519_work"), "k");
    writeFileSync(join(dir, "server.PEM"), "k");
    expect(() => validateUploadPaths([join(dir, "id_ed25519_work")], open)).toThrow(/not allowed/);
    expect(() => validateUploadPaths([join(dir, "server.PEM")], open)).toThrow(/not allowed/);
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

describe("snapshotUploads", () => {
  afterAll(() => removeSnapshots());

  it("hands out private copies with the original file name", async () => {
    const [copy] = await snapshotUploads(validateUploadPaths([file], open), open);
    expect(copy).not.toBe(file);
    expect(copy.endsWith("/report.pdf")).toBe(true);
    expect(readFileSync(copy, "utf8")).toBe("pdf");
  });

  it("refuses a file swapped for a symlink after validation", async () => {
    const box = join(dir, "box");
    mkdirSync(box);
    const target = join(box, "f.txt");
    writeFileSync(target, "ok");
    const validated = validateUploadPaths([target], open);
    unlinkSync(target);
    symlinkSync(join(dir, ".env"), target); // attacker swaps in a secret
    await expect(snapshotUploads(validated, open)).rejects.toThrow();
  });

  it("keeps same-named files from different folders apart", async () => {
    mkdirSync(join(dir, "a"));
    mkdirSync(join(dir, "b"));
    writeFileSync(join(dir, "a", "same.txt"), "A");
    writeFileSync(join(dir, "b", "same.txt"), "B");
    const copies = await snapshotUploads(validateUploadPaths([join(dir, "a", "same.txt"), join(dir, "b", "same.txt")], open), open);
    expect(copies.map((c) => readFileSync(c, "utf8"))).toEqual(["A", "B"]);
  });
});
