import type { Config } from "../config.ts";
import { resolveTarget } from "../repo/resolve.ts";
import { ensureRepo, type CacheStatus } from "../repo/clone.ts";
import {
  runAgent,
  buildPinnedUserPrompt,
  PINNED_INSTRUCTIONS,
  type AgentStepSummary,
} from "../agent/run.ts";

export type AskInput = {
  project: string;
  version?: string;
  question: string;
  max_tokens?: number;
  max_steps?: number;
  debug?: boolean;
};

export type AskSource = { file: string; line_start: number; line_end: number };

export type CitationConfidence = "ok" | "partial" | "low";

// Default response shape. steps and tokens are only included when
// the caller passes debug: true. The whole point of local-context
// is to save context in the parent agent, and the per-step trace
// is by far the largest field in a typical response.
export type AskOutput = {
  answer: string;
  sources: AskSource[];
  fetched: string[];
  version_used: string;
  cache_status: CacheStatus;
  status: "ok" | "insufficient_context" | "error";
  confidence: CitationConfidence;
  citation_audit: Record<string, string>;
  // Only present when debug=true.
  steps?: AgentStepSummary[];
  tokens?: { prompt?: number; completion?: number };
  error?: string;
};

const INSUFFICIENT_RE = /\bINSUFFICIENT_CONTEXT\b/;

// Hard bounds applied to caller-supplied tuning knobs even when the
// call did not arrive through the MCP boundary. Defaults are picked
// here too so direct programmatic callers (CLI, tests, future tools)
// see the same behaviour as MCP clients. Keep these in sync with the
// MCP schema in src/mcp/server.ts.
export const MAX_STEPS_DEFAULT = 25;
export const MAX_STEPS_MIN = 1;
export const MAX_STEPS_MAX = 25;
export const MAX_TOKENS_MIN = 128;
export const MAX_TOKENS_MAX = 8192;

function clampInt(v: number | undefined, lo: number, hi: number, fallback: number): number {
  if (v === undefined || !Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(v)));
}

export function resolveAgentLimits(input: {
  max_tokens?: number;
  max_steps?: number;
  fallbackMaxTokens: number;
}): { maxSteps: number; maxAnswerTokens: number } {
  return {
    maxSteps: clampInt(input.max_steps, MAX_STEPS_MIN, MAX_STEPS_MAX, MAX_STEPS_DEFAULT),
    maxAnswerTokens: clampInt(
      input.max_tokens,
      MAX_TOKENS_MIN,
      MAX_TOKENS_MAX,
      input.fallbackMaxTokens,
    ),
  };
}
// Accepts both [path:line] and [file:path:line]. Small models often
// copy a "file:" template literally from the caller's question (e.g.
// 'cite as [file:line]'), so we tolerate that prefix rather than
// silently dropping the citation. The optional `(?:file:)?` is
// non-capturing so the path remains in capture group 1.
const FILE_CITATION_RE = /\[(?:file:)?([\w./@-]+):(\d+)(?:-(\d+))?\]/g;
const URL_CITATION_RE = /\[(https?:\/\/[^\]\s]+)\]/g;

export type CitationRead = {
  file: string;
  line_start: number;
  line_end: number;
};

export type CitationAuditResult = {
  confidence: CitationConfidence;
  audit: Record<string, string>;
  hasCitation: boolean;
};

// Inspect each citation against what the agent actually read or fetched
// and produce a confidence signal plus a per-citation explanation.
// We deliberately do NOT gate the model's answer text on this: small
// local models often shorten paths or pick approximate line ranges,
// and rejecting their answer entirely throws away genuinely useful
// information. Instead the parent agent receives both the answer and
// a confidence flag, and can decide for itself whether to follow up.
//
// Buckets:
//   ok      every citation matches a recorded read EXACTLY in both
//           path and line range. The parent can treat this as
//           verified against on-disk source.
//   partial every citation matches via an unambiguous suffix (e.g.
//           the model wrote stream-text.ts and there is exactly one
//           packages/.../stream-text.ts among the reads, with the
//           cited range inside it). Useful, but verify if it matters.
//   low     at least one citation could not be matched (no such read,
//           ambiguous suffix, or range outside what was read) OR
//           there are zero citations. Treat as unverified; consult
//           the sources array directly.
export function auditCitations(
  answer: string,
  reads: CitationRead[],
  fetched: string[],
): CitationAuditResult {
  const audit: Record<string, string> = {};
  let exactMatches = 0;
  let suffixMatches = 0;
  let unmatched = 0;
  let total = 0;

  for (const m of answer.matchAll(FILE_CITATION_RE)) {
    total++;
    const citation = m[0]!;
    const file = m[1]!;
    const lineStart = Number(m[2]);
    const lineEnd = m[3] !== undefined ? Number(m[3]) : lineStart;
    if (
      !Number.isFinite(lineStart) ||
      !Number.isFinite(lineEnd) ||
      lineEnd < lineStart
    ) {
      audit[citation] = "malformed line range";
      unmatched++;
      continue;
    }

    // Exact path match with range fully inside a read.
    const exact = reads.find(
      (r) =>
        r.file === file &&
        lineStart >= r.line_start &&
        lineEnd <= r.line_end,
    );
    if (exact) {
      audit[citation] = `exact: ${exact.file}:${exact.line_start}-${exact.line_end}`;
      exactMatches++;
      continue;
    }

    // Unambiguous suffix match. Allow the model to shorten the path so
    // long as exactly one read ends with the cited path AND the cited
    // range fits inside it. Two index.ts files in different packages
    // would push this back to "ambiguous" / unmatched.
    const suffixCandidates = reads.filter(
      (r) =>
        (r.file === file || r.file.endsWith("/" + file)) &&
        lineStart >= r.line_start &&
        lineEnd <= r.line_end,
    );
    if (suffixCandidates.length === 1) {
      const c = suffixCandidates[0]!;
      audit[citation] = `suffix: ${c.file}:${c.line_start}-${c.line_end}`;
      suffixMatches++;
      continue;
    }
    if (suffixCandidates.length > 1) {
      audit[citation] = `ambiguous: ${suffixCandidates.length} reads match this suffix`;
      unmatched++;
      continue;
    }

    audit[citation] = "no matching read";
    unmatched++;
  }

  for (const m of answer.matchAll(URL_CITATION_RE)) {
    total++;
    const citation = m[0]!;
    const url = m[1]!;
    if (fetched.includes(url)) {
      audit[citation] = "fetched";
      exactMatches++;
    } else {
      audit[citation] = "url not fetched";
      unmatched++;
    }
  }

  const hasCitation = total > 0;
  let confidence: CitationConfidence;
  if (!hasCitation || unmatched > 0) {
    confidence = "low";
  } else if (suffixMatches > 0) {
    confidence = "partial";
  } else {
    confidence = "ok";
  }

  return { confidence, audit, hasCitation };
}

export async function askProject(
  cfg: Config,
  input: AskInput,
): Promise<AskOutput> {
  if (!input.version || input.version.trim().length === 0) {
    return {
      answer: "",
      sources: [],
      fetched: [],
      version_used: "",
      cache_status: "cloned",
      status: "error",
      confidence: "low",
      citation_audit: {},
      error:
        "ask_project requires an explicit version, tag, branch, or commit SHA. Read the caller repo's dependency version and pass it as version.",
    };
  }

  const target = resolveTarget(cfg, input.project, input.version);

  let cloneRes;
  try {
    cloneRes = await ensureRepo(cfg.reposDir, target, false);
  } catch (err) {
    return {
      answer: "",
      sources: [],
      fetched: [],
      version_used: target.ref,
      cache_status: "cloned",
      status: "error",
      confidence: "low",
      citation_audit: {},
      error: `ensureRepo failed: ${(err as Error).message}`,
    };
  }

  const versionUsed = `${target.ref}${
    cloneRes.resolvedRef && cloneRes.resolvedRef !== target.ref
      ? ` (${cloneRes.resolvedRef.slice(0, 7)})`
      : ""
  }`;

  let agent;
  try {
    const limits = resolveAgentLimits({
      max_tokens: input.max_tokens,
      max_steps: input.max_steps,
      fallbackMaxTokens: cfg.maxAnswerTokens,
    });
    agent = await runAgent({
      cfg,
      repoDir: cloneRes.dir,
      instructions: PINNED_INSTRUCTIONS,
      prompt: buildPinnedUserPrompt(
        target.name,
        versionUsed,
        input.question,
        target.paths,
      ),
      maxSteps: limits.maxSteps,
      maxAnswerTokens: limits.maxAnswerTokens,
    });
  } catch (err) {
    return {
      answer: "",
      sources: [],
      fetched: [],
      version_used: versionUsed,
      cache_status: cloneRes.status,
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

  // Only replace the model's text with the INSUFFICIENT_CONTEXT sentinel
  // when the model itself declared it. Otherwise we always return the
  // actual answer plus a confidence signal so the parent agent can decide.
  const out: AskOutput = {
    answer,
    sources: agent.reads,
    fetched: agent.fetched,
    version_used: versionUsed,
    cache_status: cloneRes.status,
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
