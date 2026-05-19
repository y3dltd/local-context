import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type ProjectEntry = {
  url: string;
  default_branch: string;
  paths?: string[];
  tag_prefix?: string;
};

export type ProjectCatalog = Record<string, ProjectEntry>;

export type Config = {
  modelEndpoint: string;
  model: string;
  reposDir: string;
  maxAnswerTokens: number;
  catalog: ProjectCatalog;
  rootDir: string;
};

const REPO_ROOT = resolve(import.meta.dir, "..");

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

// When an MCP-launched server starts, the parent agent's cwd is wherever
// the agent was, not this repo. Bun's automatic .env loading is
// cwd-relative, so we load REPO_ROOT/.env ourselves. Existing process
// env wins so an explicit override always beats the file. Exported for
// unit tests; loadConfig calls it with REPO_ROOT.
export function loadDotEnv(repoRoot: string = REPO_ROOT): void {
  const envFile = join(repoRoot, ".env");
  if (!existsSync(envFile)) return;
  let raw: string;
  try {
    raw = readFileSync(envFile, "utf8");
  } catch {
    return;
  }
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function requireModel(fromUserCfg: string | undefined): string {
  const env =
    process.env.LOCAL_CONTEXT_MODEL ??
    process.env.MODEL_NAME ??
    process.env.OPENAI_MODEL;
  if (env && env.trim().length > 0) return env;
  if (fromUserCfg && fromUserCfg.trim().length > 0) return fromUserCfg;
  throw new Error(
    "No model configured. Set LOCAL_CONTEXT_MODEL (or MODEL_NAME / OPENAI_MODEL) in your environment, " +
      'or set "model" in ~/.local-context.json. See .env.example for the full list of supported variables.',
  );
}

export function loadConfig(): Config {
  loadDotEnv();
  const userFile = join(homedir(), ".local-context.json");
  const userCfg =
    (existsSync(userFile) && readJson<Partial<Config>>(userFile)) || {};

  const catalogFile = join(REPO_ROOT, "projects.json");
  const catalogRaw =
    readJson<{ projects: ProjectCatalog }>(catalogFile)?.projects ?? {};

  return {
    modelEndpoint:
      process.env.LOCAL_CONTEXT_MODEL_ENDPOINT ??
      process.env.MODEL_ENDPOINT ??
      process.env.OPENAI_BASE_URL ??
      userCfg.modelEndpoint ??
      "http://127.0.0.1:8088/v1",
    model: requireModel(userCfg.model),
    reposDir:
      process.env.LOCAL_CONTEXT_REPOS_DIR ??
      userCfg.reposDir ??
      join(REPO_ROOT, "repos"),
    maxAnswerTokens: userCfg.maxAnswerTokens ?? 4096,
    catalog: catalogRaw,
    rootDir: REPO_ROOT,
  };
}
