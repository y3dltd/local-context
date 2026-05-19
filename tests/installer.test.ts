import { describe, expect, test } from "bun:test";
import {
  claudeCodeMcpAddArgs,
  claudeCodeMcpRemoveArgs,
  upsertCodexLocalContextBlock,
} from "../bin/cli.ts";

const ENTRY = "/abs/local-context/bin/server.ts";

describe("Codex installer upsert", () => {
  test("appends our block when missing", () => {
    const before = `[mcp_servers.fetch]\ncommand = "docker"\nargs = ["run", "mcp/fetch"]\n`;
    const after = upsertCodexLocalContextBlock(before, ENTRY);
    expect(after).toContain("[mcp_servers.fetch]");
    expect(after).toContain("[mcp_servers.local-context]");
    expect(after).toContain(`args = ["${ENTRY}"]`);
  });

  test("running twice produces the same content (idempotent)", () => {
    const seed = `[mcp_servers.fetch]\ncommand = "docker"\nargs = ["run", "mcp/fetch"]\n`;
    const once = upsertCodexLocalContextBlock(seed, ENTRY);
    const twice = upsertCodexLocalContextBlock(once, ENTRY);
    expect(twice).toBe(once);
  });

  test("survives the broken-by-old-regex case with inline arrays", () => {
    // The previous /[^\[]/m regex stopped at the `[` in `args = [...]`,
    // leaving a half-deleted [mcp_servers.local-context] block. Make
    // sure this body upserts to a single, clean block.
    const stale = [
      "[mcp_servers.tavily]",
      'url = "https://mcp.tavily.com/mcp/?tavilyApiKey=demo"',
      "",
      "[mcp_servers.local-context]",
      'command = "bun"',
      'args = ["/old/path/server.ts"]',
      "",
      "[mcp_servers.fetch]",
      'command = "docker"',
      "",
    ].join("\n");
    const fixed = upsertCodexLocalContextBlock(stale, ENTRY);

    // Old path is gone.
    expect(fixed).not.toContain("/old/path/server.ts");
    // New path is present.
    expect(fixed).toContain(`args = ["${ENTRY}"]`);
    // Only one [mcp_servers.local-context] block.
    const occurrences = fixed.split("[mcp_servers.local-context]").length - 1;
    expect(occurrences).toBe(1);
    // Unrelated blocks survive.
    expect(fixed).toContain("[mcp_servers.tavily]");
    expect(fixed).toContain("[mcp_servers.fetch]");
  });

  test("works when the block is the only content", () => {
    const stale = [
      "[mcp_servers.local-context]",
      'command = "bun"',
      'args = ["/old/path/server.ts"]',
    ].join("\n");
    const fixed = upsertCodexLocalContextBlock(stale, ENTRY);
    expect(fixed).toContain(`args = ["${ENTRY}"]`);
    expect(fixed).not.toContain("/old/path/server.ts");
    const occurrences = fixed.split("[mcp_servers.local-context]").length - 1;
    expect(occurrences).toBe(1);
  });

  test("works on an empty file", () => {
    const fixed = upsertCodexLocalContextBlock("", ENTRY);
    expect(fixed).toContain("[mcp_servers.local-context]");
    expect(fixed).toContain(`args = ["${ENTRY}"]`);
  });
});

describe("Claude Code installer args", () => {
  test("uses the supported Claude Code user-scope MCP command", () => {
    expect(claudeCodeMcpAddArgs(ENTRY)).toEqual([
      "mcp",
      "add",
      "--scope",
      "user",
      "local-context",
      "--",
      "bun",
      ENTRY,
    ]);
  });

  test("removes the previous user-scope entry before adding", () => {
    expect(claudeCodeMcpRemoveArgs()).toEqual([
      "mcp",
      "remove",
      "--scope",
      "user",
      "local-context",
    ]);
  });
});
