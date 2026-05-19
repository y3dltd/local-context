import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateLocalPath } from "../src/tools/ask_local.ts";

let scratchDir = "";
let repoDir = "";
let filePath = "";
let symlinkDir = "";

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "local-context-asklocal-"));
  repoDir = join(scratchDir, "my-app");
  mkdirSync(repoDir);
  writeFileSync(join(repoDir, "README.md"), "hi");

  // A regular file (not a directory).
  filePath = join(scratchDir, "regular-file.txt");
  writeFileSync(filePath, "x");

  // A symlinked directory: realpath should resolve to repoDir.
  symlinkDir = join(scratchDir, "via-symlink");
  symlinkSync(repoDir, symlinkDir);
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

describe("validateLocalPath", () => {
  test("accepts an absolute path to an existing directory", () => {
    const r = validateLocalPath(repoDir);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolvedPath).toBe(repoDir);
  });

  test("rejects relative paths", () => {
    const r = validateLocalPath("./relative/path");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("absolute");
  });

  test("rejects empty path", () => {
    const r = validateLocalPath("");
    expect(r.ok).toBe(false);
  });

  test("rejects whitespace-only path", () => {
    const r = validateLocalPath("   ");
    expect(r.ok).toBe(false);
  });

  test("rejects non-existent absolute path", () => {
    const r = validateLocalPath("/this/path/should/not/exist/abcdef");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("does not exist");
  });

  test("rejects a regular file (must be a directory)", () => {
    const r = validateLocalPath(filePath);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not a directory");
  });

  test("resolves a symlinked directory to its real path", () => {
    const r = validateLocalPath(symlinkDir);
    expect(r.ok).toBe(true);
    // resolvedPath should be the real underlying directory, not the
    // symlink itself. That way downstream safeReal checks operate on
    // the canonical root.
    if (r.ok) expect(r.resolvedPath).toBe(repoDir);
  });

  test("rejects non-string input", () => {
    // @ts-expect-error: deliberately exercising the runtime guard.
    const r = validateLocalPath(undefined);
    expect(r.ok).toBe(false);
  });

  test("an absolute path with .. components resolves via realpath", () => {
    // /tmp/.../my-app/../my-app should canonicalise to /tmp/.../my-app.
    // Validator does NOT do lexical .. rejection; it relies on
    // realpathSync. Pin this so a future refactor that adds lexical
    // checks does not silently change the contract.
    const trickyButValid = join(repoDir, "..", "my-app");
    const r = validateLocalPath(trickyButValid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.resolvedPath).toBe(repoDir);
  });

  test("rejects a dangling symlink (target removed)", () => {
    const danglingTarget = join(scratchDir, "will-be-removed");
    const dangling = join(scratchDir, "dangling-link");
    mkdirSync(danglingTarget);
    symlinkSync(danglingTarget, dangling);
    rmSync(danglingTarget, { recursive: true, force: true });
    // The link now exists but its target does not. existsSync() returns
    // false through a broken symlink, so we reject at the existence
    // check rather than later in realpathSync. The exact error matters
    // less than rejecting it cleanly.
    const r = validateLocalPath(dangling);
    expect(r.ok).toBe(false);
  });
});
