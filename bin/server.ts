#!/usr/bin/env bun
import { startServer } from "../src/mcp/server.ts";

startServer().catch((err) => {
  // MCP stdio convention: do not print to stdout; logs go to stderr.
  console.error("[local-context] fatal:", err);
  process.exit(1);
});
