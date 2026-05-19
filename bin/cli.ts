#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { loadConfig } from "../src/config.ts";
import { askProject } from "../src/tools/ask.ts";
import { listProjects } from "../src/tools/list.ts";
import { updateProject } from "../src/tools/update.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SERVER_ENTRY = join(REPO_ROOT, "bin/server.ts");

function usage(): never {
  console.error(
    [
      "local-context: MCP sidecar for coding agents",
      "",
      "Usage:",
      "  bun bin/cli.ts start                          # run the MCP server on stdio",
      "  bun bin/cli.ts list                           # show catalog + cached repos",
      "  bun bin/cli.ts update <project> [version]     # force re-clone",
      "  bun bin/cli.ts ask <project> <ver> <question> # one-shot CLI query",
      "  bun bin/cli.ts install --target <agent>       # claude-code | codex | opencode | pi | all",
    ].join("\n"),
  );
  process.exit(1);
}

function backup(path: string): void {
  if (!existsSync(path)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  copyFileSync(path, `${path}.bak.${stamp}`);
}

function ensureDir(d: string): void {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

function installClaudeCode(): string {
  runClaude(claudeCodeMcpRemoveArgs(), { allowFailure: true });
  runClaude(claudeCodeMcpAddArgs(SERVER_ENTRY));
  return "Claude Code user-scope MCP config (via `claude mcp add --scope user`)";
}

export function claudeCodeMcpAddArgs(serverEntry: string): string[] {
  return [
    "mcp",
    "add",
    "--scope",
    "user",
    "local-context",
    "--",
    "bun",
    serverEntry,
  ];
}

export function claudeCodeMcpRemoveArgs(): string[] {
  return ["mcp", "remove", "--scope", "user", "local-context"];
}

function runClaude(
  args: string[],
  opts: { allowFailure?: boolean } = {},
): void {
  const res = spawnSync("claude", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (res.error) {
    throw new Error(
      "Claude Code CLI not found. Install Claude Code, then run: " +
        `claude mcp add --scope user local-context -- bun ${SERVER_ENTRY}`,
    );
  }

  if ((res.status ?? 1) !== 0 && !opts.allowFailure) {
    const detail = (res.stderr || res.stdout || "").trim();
    throw new Error(
      `claude ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
    );
  }
}

// Exported for unit testing. Removes the [mcp_servers.local-context]
// block from a TOML body if present, then appends a fresh one. The
// removal walks line-by-line from the marker to the next line that
// starts with `[`, so inline arrays like `args = [...]` no longer
// truncate the deletion mid-block.
export function upsertCodexLocalContextBlock(
  body: string,
  serverEntry: string,
): string {
  const marker = "[mcp_servers.local-context]";
  let out = body;
  if (out.includes(marker)) {
    const lines = out.split("\n");
    const start = lines.findIndex((l) => l.trim() === marker);
    if (start >= 0) {
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i++) {
        if (lines[i]!.startsWith("[")) {
          end = i;
          break;
        }
      }
      lines.splice(start, end - start);
      out = lines.join("\n").replace(/\n{3,}/g, "\n\n");
    }
  }
  if (!out.endsWith("\n")) out += "\n";
  out +=
    "\n" +
    [
      "[mcp_servers.local-context]",
      `command = "bun"`,
      `args = [${JSON.stringify(serverEntry)}]`,
      "",
    ].join("\n");
  return out;
}

function installCodex(): string {
  const target = join(homedir(), ".codex/config.toml");
  ensureDir(dirname(target));
  const body = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (existsSync(target)) backup(target);
  writeFileSync(target, upsertCodexLocalContextBlock(body, SERVER_ENTRY));
  return target;
}

function installOpenCode(): string {
  const target = join(homedir(), ".config/opencode/opencode.json");
  ensureDir(dirname(target));
  let cfg: { mcp?: Record<string, unknown> } = {};
  if (existsSync(target)) {
    try {
      cfg = JSON.parse(readFileSync(target, "utf8"));
    } catch {
      cfg = {};
    }
    backup(target);
  }
  cfg.mcp = {
    ...(cfg.mcp ?? {}),
    "local-context": {
      type: "local",
      command: ["bun", SERVER_ENTRY],
      enabled: true,
    },
  };
  writeFileSync(target, JSON.stringify(cfg, null, 2) + "\n");
  return target;
}

function installPi(): string {
  const dir = join(homedir(), ".pi/agent/extensions/local-context");
  ensureDir(dir);
  const manifest = {
    name: "local-context",
    version: "0.1.0",
    type: "mcp",
    transport: "stdio",
    command: "bun",
    args: [SERVER_ENTRY],
    description:
      "Version-pinned upstream-repo Q&A via a small local model. Use for narrow library facts.",
  };
  const path = join(dir, "manifest.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");

  // Also copy the SKILL.md for PI's skill loader if present.
  const src = join(REPO_ROOT, "skills/local-context/SKILL.md");
  const piSkillDir = join(homedir(), ".pi/agent/skills/local-context");
  if (existsSync(src)) {
    ensureDir(piSkillDir);
    copyFileSync(src, join(piSkillDir, "SKILL.md"));
  }
  return path;
}

function installClaudeSkill(): string {
  const src = join(REPO_ROOT, "skills/local-context/SKILL.md");
  if (!existsSync(src)) return "(skipped: SKILL.md not yet present)";
  const dir = join(homedir(), ".claude/skills/local-context");
  ensureDir(dir);
  const dst = join(dir, "SKILL.md");
  copyFileSync(src, dst);
  return dst;
}

async function cmdInstall(target: string): Promise<void> {
  const targets =
    target === "all"
      ? ["claude-code", "codex", "opencode", "pi"]
      : [target];
  for (const t of targets) {
    try {
      let where = "";
      switch (t) {
        case "claude-code":
          where = installClaudeCode();
          console.log(`claude-code MCP wired:   ${where}`);
          where = installClaudeSkill();
          console.log(`claude-code SKILL.md:    ${where}`);
          break;
        case "codex":
          where = installCodex();
          console.log(`codex MCP wired:         ${where}`);
          break;
        case "opencode":
          where = installOpenCode();
          console.log(`opencode MCP wired:      ${where}`);
          break;
        case "pi":
          where = installPi();
          console.log(`pi extension:            ${where}`);
          break;
        default:
          console.error(`unknown target: ${t}`);
          process.exitCode = 1;
      }
    } catch (e) {
      console.error(`install --target ${t} failed:`, (e as Error).message);
      process.exitCode = 1;
    }
  }
}

async function cmdAsk(
  project: string,
  version: string,
  question: string,
): Promise<void> {
  const cfg = loadConfig();
  const out = await askProject(cfg, {
    project,
    version: version === "-" ? undefined : version,
    question,
  });
  console.log(JSON.stringify(out, null, 2));
}

async function cmdList(): Promise<void> {
  console.log(JSON.stringify(listProjects(loadConfig()), null, 2));
}

async function cmdUpdate(project: string, version?: string): Promise<void> {
  const out = await updateProject(loadConfig(), { project, version });
  console.log(JSON.stringify(out, null, 2));
}

function cmdStart(): void {
  const child = spawn("bun", [SERVER_ENTRY], { stdio: "inherit" });
  child.on("close", (code) => process.exit(code ?? 0));
}

async function main(): Promise<void> {
  const [, , sub, ...rest] = process.argv;
  switch (sub) {
    case "start":
      cmdStart();
      break;
    case "list":
      await cmdList();
      break;
    case "update": {
      const project = rest[0];
      const version = rest[1];
      if (!project) usage();
      await cmdUpdate(project, version);
      break;
    }
    case "ask": {
      const [project, version, ...qWords] = rest;
      if (!project || !version || qWords.length === 0) usage();
      await cmdAsk(project, version, qWords.join(" "));
      break;
    }
    case "install": {
      const flag = rest[0];
      const value = rest[1];
      if (flag !== "--target" || !value) usage();
      await cmdInstall(value);
      break;
    }
    default:
      usage();
  }
}

// Only run the CLI entrypoint when invoked directly (e.g. `bun bin/cli.ts`),
// not when imported by a test or another module. import.meta.main is true
// when this file is the program's entry point under Bun.
if (import.meta.main) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
