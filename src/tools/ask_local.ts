import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Config } from "../config.ts";
import {
  runAgent,
  buildLocalUserPrompt,
  LOCAL_INSTRUCTIONS,
  type AgentStepSummary,
} from "../agent/run.ts";
import {
  auditCitations,
  resolveAgentLimits,
  type AskSource,
  type CitationConfidence,
} from "./ask.ts";

export type AskLocalInput = {
  path: string;
  question: string;
  paths?: string[];
  max_tokens?: number;
  max_steps?: number;
  debug?: boolean;
};

// Default response shape. steps and tokens are only included when
// debug: true is passed; otherwise we omit them to save the parent
// agent's context budget. See ask.ts AskOutput for the matching
// pinned-mode shape.
export type AskLocalOutput = {
  answer: string;
  sources: AskSource[];
  fetched: string[];
  repo_path: string;
  status: "ok" | "insufficient_context" | "error";
  confidence: CitationConfidence;
  citation_audit: Record<string, string>;
  // Only present when debug=true.
  steps?: AgentStepSummary[];
  tokens?: { prompt?: number; completion?: number };
  error?: string;
};

export type LocalPathValidation =
  | { ok: true; resolvedPath: string }
  | { ok: false; error: string };

// Validate that `path` is a real, absolute directory we can grep/read.
// Exported for unit testing. We deliberately do NOT add an allow-list
// here: the parent agent decides which local repos to ask about, and
// the tool runs in the user's own process with the user's own
// permissions. The agent's read/grep tools already use safeReal to
// stop symlinks escaping the repo root we pass in.
export function validateLocalPath(path: string): LocalPathValidation {
  if (typeof path !== "string" || path.trim() === "") {
    return { ok: false, error: "path is required" };
  }
  if (!isAbsolute(path)) {
    return {
      ok: false,
      error: `path must be absolute, got: ${path}`,
    };
  }
  if (!existsSync(path)) {
    return { ok: false, error: `path does not exist: ${path}` };
  }
  let stat;
  try {
    stat = statSync(path);
  } catch (e) {
    return { ok: false, error: `cannot stat path: ${(e as Error).message}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `path is not a directory: ${path}` };
  }
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch (e) {
    return {
      ok: false,
      error: `cannot resolve path: ${(e as Error).message}`,
    };
  }
  return { ok: true, resolvedPath: resolved };
}

const INSUFFICIENT_RE = /\bINSUFFICIENT_CONTEXT\b/;

export async function askLocal(
  cfg: Config,
  input: AskLocalInput,
): Promise<AskLocalOutput> {
  const validation = validateLocalPath(input.path);
  if (!validation.ok) {
    return {
      answer: "",
      sources: [],
      fetched: [],
      repo_path: input.path,
      status: "error",
      confidence: "low",
      citation_audit: {},
      error: validation.error,
    };
  }

  if (typeof input.question !== "string" || input.question.trim() === "") {
    return {
      answer: "",
      sources: [],
      fetched: [],
      repo_path: validation.resolvedPath,
      status: "error",
      confidence: "low",
      citation_audit: {},
      error: "question is required",
    };
  }

  let agent;
  try {
    const limits = resolveAgentLimits({
      max_tokens: input.max_tokens,
      max_steps: input.max_steps,
      fallbackMaxTokens: cfg.maxAnswerTokens,
    });
    agent = await runAgent({
      cfg,
      repoDir: validation.resolvedPath,
      instructions: LOCAL_INSTRUCTIONS,
      prompt: buildLocalUserPrompt(
        validation.resolvedPath,
        input.question,
        input.paths,
      ),
      maxSteps: limits.maxSteps,
      maxAnswerTokens: limits.maxAnswerTokens,
    });
  } catch (err) {
    return {
      answer: "",
      sources: [],
      fetched: [],
      repo_path: validation.resolvedPath,
      status: "error",
      confidence: "low",
      citation_audit: {},
      error: (err as Error).message,
    };
  }

  const answer = agent.answer;
  const insufficient = INSUFFICIENT_RE.test(answer);
  const { confidence, audit } = auditCitations(
    answer,
    agent.reads,
    agent.fetched,
  );

  const out: AskLocalOutput = {
    answer,
    sources: agent.reads,
    fetched: agent.fetched,
    repo_path: validation.resolvedPath,
    status: insufficient ? "insufficient_context" : "ok",
    confidence,
    citation_audit: audit,
  };
  if (input.debug) {
    out.steps = agent.steps;
    out.tokens = agent.tokens;
  }
  return out;
}
