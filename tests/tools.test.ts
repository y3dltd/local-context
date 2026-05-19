import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTools,
  validateWebFetchTarget,
  type AgentToolsCtx,
} from "../src/agent/tools.ts";

let scratchDir = "";
let repoDir = "";
let outsideFile = "";
let symlinkAvailable = false;

beforeAll(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "local-context-test-"));
  repoDir = join(scratchDir, "repo");
  mkdirSync(repoDir, { recursive: true });

  // A file safely inside the "repo".
  writeFileSync(join(repoDir, "ok.txt"), "line1\nline2\nline3\n");

  // A file outside the "repo" that the symlink will try to expose.
  outsideFile = join(scratchDir, "secret.txt");
  writeFileSync(outsideFile, "this is host-side secret content\n");

  // A symlink inside the repo pointing outside it. Some Windows setups
  // disallow file symlinks without developer mode/admin rights, so keep
  // the rest of the tests runnable if this setup step is unavailable.
  try {
    symlinkSync(outsideFile, join(repoDir, "escape.txt"));
    symlinkAvailable = true;
  } catch {
    symlinkAvailable = false;
  }
});

afterAll(() => {
  rmSync(scratchDir, { recursive: true, force: true });
});

function makeCtx(): AgentToolsCtx {
  return { repoDir, reads: [], fetched: [] };
}

describe("read_file symlink escape", () => {
  test("ok.txt inside the repo reads normally", async () => {
    const tools = buildTools(makeCtx());
    const exec = (tools.read_file as unknown as { execute: Function }).execute;
    const r = await exec({ file: "ok.txt", line_start: 1, line_end: 3 });
    // Lines are now prefixed with absolute file line numbers in the
    // form "N| content". The original content is still in the text,
    // just with a prefix added.
    expect(r.text).toContain("line1");
    expect(r.text).toContain("1| line1");
  });

  test("line-number prefix uses absolute file lines and pads correctly", async () => {
    // Build a 15-line file so we exercise both 1-digit and 2-digit
    // line numbers. The padding width should be the width of the
    // largest line in the range, so when reading lines 5..15 we
    // expect ` 5|` (padded) and `15|` to line up.
    const padFile = join(repoDir, "padded.txt");
    const content = Array.from({ length: 15 }, (_, i) => `content-${i + 1}`).join("\n");
    writeFileSync(padFile, content);
    const tools = buildTools(makeCtx());
    const exec = (tools.read_file as unknown as { execute: Function }).execute;
    const r = await exec({ file: "padded.txt", line_start: 5, line_end: 15 });
    expect(r.line_start).toBe(5);
    expect(r.line_end).toBe(15);
    // First returned line is absolute line 5, padded to 2 chars.
    expect(r.text.split("\n")[0]).toBe(" 5| content-5");
    // Last returned line is absolute line 15, unpadded.
    expect(r.text.split("\n").at(-1)).toBe("15| content-15");
    // The model gets the absolute number on every line.
    expect(r.text).toContain("10| content-10");
  });

  test("symlink whose target is outside the repo is rejected", async () => {
    if (!symlinkAvailable) return;
    const tools = buildTools(makeCtx());
    const exec = (tools.read_file as unknown as { execute: Function }).execute;
    const r = await exec({ file: "escape.txt", line_start: 1, line_end: 5 });
    expect(r.error).toBeDefined();
    expect(r.text).toBeUndefined();
  });

  test("relative traversal outside the repo is rejected even without symlinks", async () => {
    const tools = buildTools(makeCtx());
    const exec = (tools.read_file as unknown as { execute: Function }).execute;
    const r = await exec({
      file: "../secret.txt",
      line_start: 1,
      line_end: 5,
    });
    expect(r.error).toBeDefined();
  });

  test("absolute paths outside the repo are rejected", async () => {
    const tools = buildTools(makeCtx());
    const exec = (tools.read_file as unknown as { execute: Function }).execute;
    const r = await exec({
      file: outsideFile,
      line_start: 1,
      line_end: 5,
    });
    expect(r.error).toBeDefined();
  });
});

describe("web_fetch SSRF protection", () => {
  // Important: these tests never actually fetch; the safety checks
  // run before any network call.
  function execFetch(): (args: { url: string }) => Promise<any> {
    const tools = buildTools(makeCtx());
    return (tools.web_fetch as unknown as {
      execute: (args: { url: string }) => Promise<any>;
    }).execute;
  }

  test("blocks loopback IP literal", async () => {
    delete process.env.LOCAL_CONTEXT_ALLOW_PRIVATE_FETCH;
    const r = await execFetch()({ url: "http://127.0.0.1/" });
    expect(r.error).toContain("private");
  });

  test("blocks cloud metadata IP", async () => {
    delete process.env.LOCAL_CONTEXT_ALLOW_PRIVATE_FETCH;
    const r = await execFetch()({ url: "http://169.254.169.254/latest/meta-data/" });
    expect(r.error).toContain("private");
  });

  test("blocks RFC1918 hostnames once resolved", async () => {
    delete process.env.LOCAL_CONTEXT_ALLOW_PRIVATE_FETCH;
    const r = await execFetch()({ url: "http://10.0.0.1/admin" });
    expect(r.error).toContain("private");
  });

  test("blocks URLs with embedded credentials", async () => {
    delete process.env.LOCAL_CONTEXT_ALLOW_PRIVATE_FETCH;
    const r = await execFetch()({ url: "http://user:pass@example.com/" });
    expect(r.error).toContain("credentials");
  });

  test("blocks non-standard ports", async () => {
    delete process.env.LOCAL_CONTEXT_ALLOW_PRIVATE_FETCH;
    const r = await execFetch()({ url: "http://example.com:8080/" });
    expect(r.error).toMatch(/port/);
  });

  test("blocks IPv6 loopback", async () => {
    delete process.env.LOCAL_CONTEXT_ALLOW_PRIVATE_FETCH;
    const r = await execFetch()({ url: "http://[::1]/" });
    expect(r.error).toContain("private");
  });

  test("allows opt-out for homelab use", async () => {
    const r = await validateWebFetchTarget("http://127.0.0.1:1/", true);
    expect(r.ok).toBe(true);
  });

  test("target validator blocks localhost before fetch", async () => {
    const r = await validateWebFetchTarget("http://localhost/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("private");
  });

  test("target validator blocks credentials before DNS/fetch", async () => {
    const r = await validateWebFetchTarget("http://user:pass@example.com/");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("credentials");
  });
});
