import { describe, expect, test } from "bun:test";
import { clampMcpInteger } from "../src/mcp/server.ts";

describe("MCP argument bounds", () => {
  test("clamps finite numeric values to integer bounds", () => {
    expect(clampMcpInteger(9000, 128, 8192)).toBe(8192);
    expect(clampMcpInteger(64, 128, 8192)).toBe(128);
    expect(clampMcpInteger(12.9, 1, 25)).toBe(12);
  });

  test("ignores non-numeric and non-finite values", () => {
    expect(clampMcpInteger("4096", 128, 8192)).toBeUndefined();
    expect(clampMcpInteger(Number.NaN, 128, 8192)).toBeUndefined();
    expect(clampMcpInteger(Number.POSITIVE_INFINITY, 128, 8192)).toBeUndefined();
  });
});
