import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDotEnv } from "../src/config.ts";

const SCRATCH_KEYS = [
  "LC_TEST_KEY_A",
  "LC_TEST_KEY_B",
  "LC_TEST_KEY_C",
  "LC_TEST_BAD_NAME_KEY",
];

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "local-context-env-"));
}

beforeEach(() => {
  for (const k of SCRATCH_KEYS) delete process.env[k];
});

describe("loadDotEnv", () => {
  test("loads simple KEY=VALUE pairs into process.env", () => {
    const dir = freshDir();
    try {
      writeFileSync(
        join(dir, ".env"),
        ["LC_TEST_KEY_A=alpha", "LC_TEST_KEY_B=beta"].join("\n"),
      );
      loadDotEnv(dir);
      expect(process.env.LC_TEST_KEY_A).toBe("alpha");
      expect(process.env.LC_TEST_KEY_B).toBe("beta");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("existing process.env wins over .env (no silent override)", () => {
    const dir = freshDir();
    try {
      writeFileSync(join(dir, ".env"), "LC_TEST_KEY_A=from-file");
      process.env.LC_TEST_KEY_A = "from-real-env";
      loadDotEnv(dir);
      expect(process.env.LC_TEST_KEY_A).toBe("from-real-env");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("strips surrounding double / single quotes", () => {
    const dir = freshDir();
    try {
      writeFileSync(
        join(dir, ".env"),
        ['LC_TEST_KEY_A="quoted-double"', "LC_TEST_KEY_B='quoted-single'"].join("\n"),
      );
      loadDotEnv(dir);
      expect(process.env.LC_TEST_KEY_A).toBe("quoted-double");
      expect(process.env.LC_TEST_KEY_B).toBe("quoted-single");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ignores comments and blank lines", () => {
    const dir = freshDir();
    try {
      writeFileSync(
        join(dir, ".env"),
        [
          "# this is a comment",
          "",
          "LC_TEST_KEY_A=ok",
          "   # indented comment",
          "",
        ].join("\n"),
      );
      loadDotEnv(dir);
      expect(process.env.LC_TEST_KEY_A).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips lines with invalid identifier characters", () => {
    const dir = freshDir();
    try {
      writeFileSync(
        join(dir, ".env"),
        ["LC-BAD=x", "LC_TEST_KEY_A=good"].join("\n"),
      );
      loadDotEnv(dir);
      expect(process.env["LC-BAD"]).toBeUndefined();
      expect(process.env.LC_TEST_KEY_A).toBe("good");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns silently when no .env exists", () => {
    const dir = freshDir();
    try {
      expect(() => loadDotEnv(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
