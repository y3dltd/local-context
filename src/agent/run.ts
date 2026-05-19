import { ToolLoopAgent, isStepCount } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Config } from "../config.ts";
import { buildTools, type AgentToolsCtx } from "./tools.ts";

// Instructions for the "pinned" mode: third-party library at a specific
// version that we cloned into repos/<project>@<version>/. Emphasises
// version-pinned facts and warns against memory.
export const PINNED_INSTRUCTIONS = `You are local-context. Answer a narrow question about one pinned library version using only tool results.

Tools:
- grep_repo({pattern, path?, max_results?}): find where a symbol or phrase appears in the cloned repo at the exact version specified.
- read_file({file, line_start, line_end}): read context around a hit.
- web_search/web_fetch: use only when the repo cannot answer.

Workflow:
1. Grep the exact identifier. If the question includes a path, use it first.
2. If asked for a definition/declaration/export/implementation/source of truth, do not stop at a usage site; find and cite the declaration/implementation. Usage sites are OK only when asked for usage or when no definition is found after targeted searches.
3. If hits are mostly docs/tests/examples/generated/compat/content, grep again under source paths like packages, src, or the user's path hint.
4. read_file with a GENEROUS line range. If grep returned line N, default to line_start = max(1, N - 15), line_end = N + 60 on your first read. Reading only the signature line (e.g. lines 12-13) is never enough to describe a function's behaviour - you need the body too. The tool caps at 120 lines per call, so you have room to be generous.
5. Before answering, scan your draft for hedge phrases: "I was unable", "I cannot find", "I cannot provide", "not visible", "not shown", "not entirely visible", "not in the context", "implementation is not shown". If ANY appears, do another tool call BEFORE answering - widen the read_file range by another 50 lines, or grep a related identifier. Do not ship a hedged answer until you have made at least 3 progressively wider read_file calls on the most likely file.
6. Use web_search/web_fetch only if the repo genuinely cannot answer. Then answer.

Rules:
- No internal memory. Copy every API name exactly from tool results.
- If a name is not in tool results, grep again or say it is not shown.
- Do not invent file names, signatures, option names, or exports.

Final answer rules:
- 2-4 focused sentences.
- Every factual claim ends with [exact/repo/path:line] or [url].
- File citations must use the exact repo-relative path from read_file and lines/ranges you actually read.
- Citation format is [path:line] or [path:start-end]. Do NOT add a "file:" prefix even if the caller's question shows that template; write [src/foo.ts:42], not [file:src/foo.ts:42].
- Prefer source over docs. If citing usage instead of definition, say so.
- Output exactly INSUFFICIENT_CONTEXT only when tool results are useless/off-topic.`;

// Instructions for the "local" mode: the user's own working tree. No
// version pin; the answer is grounded in whatever is on disk right now,
// including uncommitted changes.
export const LOCAL_INSTRUCTIONS = `You are local-context. Answer a narrow question about a local code repository (the user's current working tree) using only tool results.

Tools:
- grep_repo({pattern, path?, max_results?}): find where a symbol or phrase appears in the local repo.
- read_file({file, line_start, line_end}): read context around a hit.
- web_search/web_fetch: only if the repo genuinely cannot answer (rare for questions about local code).

Workflow:
1. Grep the exact identifier. If the question includes a path, use it first.
2. If asked for a definition/declaration/implementation/source of truth, do not stop at a usage site; find and cite the declaration/implementation.
3. If hits are mostly tests/generated/build output (e.g. .next, dist, build, node_modules, *.test.*), narrow with the user's path hint or under source folders like src/, app/, lib/, packages/<x>/src.
4. read_file with a GENEROUS line range. If grep returned line N, default to line_start = max(1, N - 15), line_end = N + 60 on your first read. Reading only the signature line (e.g. lines 12-13) is never enough to describe a function's behaviour - you need the body too. The tool caps at 120 lines per call, so you have room to be generous.
5. Before answering, scan your draft for hedge phrases: "I was unable", "I cannot find", "I cannot provide", "not visible", "not shown", "not entirely visible", "not in the context", "implementation is not shown". If ANY appears, do another tool call BEFORE answering - widen the read_file range by another 50 lines, or grep a related identifier. Do not ship a hedged answer until you have made at least 3 progressively wider read_file calls on the most likely file.
6. Use web_search/web_fetch only if the local repo genuinely cannot answer (rare).

Rules:
- No internal memory. Copy every name exactly from tool results.
- If a name is not in tool results, grep again or say it is not shown.
- Do not invent file names, signatures, option names, or exports.

Final answer rules:
- 2-4 focused sentences.
- Every factual claim ends with [exact/repo/path:line] or [url].
- File citations must use the exact repo-relative path from read_file and lines/ranges you actually read.
- Citation format is [path:line] or [path:start-end]. Do NOT add a "file:" prefix even if the caller's question shows that template; write [src/foo.ts:42], not [file:src/foo.ts:42].
- Output exactly INSUFFICIENT_CONTEXT only when tool results are useless/off-topic.`;

export function buildPinnedUserPrompt(
  project: string,
  version: string,
  question: string,
  paths: string[] | undefined,
): string {
  const hint =
    paths && paths.length > 0
      ? `Hint: this project's source typically lives under ${paths.map((p) => `"${p}"`).join(", ")}. Prefer those paths in your first grep_repo call.`
      : "";
  return [
    `Project: ${project}`,
    `Version: ${version}`,
    `Question: ${question}`,
    hint,
    "",
    "Use the tools to find the answer in the cloned repo first, then answer.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildLocalUserPrompt(
  repoPath: string,
  question: string,
  paths: string[] | undefined,
): string {
  const hint =
    paths && paths.length > 0
      ? `Hint: source code in this repo typically lives under ${paths.map((p) => `"${p}"`).join(", ")}. Prefer those paths in your first grep_repo call.`
      : "";
  return [
    `Local repository: ${repoPath}`,
    `Question: ${question}`,
    hint,
    "",
    "Use the tools to find the answer in the working tree first, then answer.",
  ]
    .filter(Boolean)
    .join("\n");
}

export type AgentRunInput = {
  cfg: Config;
  repoDir: string;
  instructions: string;
  prompt: string;
  maxSteps?: number;
  maxAnswerTokens?: number;
};

export type AgentStepSummary = {
  step: number;
  tool?: string;
  arguments?: unknown;
  result_preview?: string;
};

export type AgentRunOutput = {
  answer: string;
  steps: AgentStepSummary[];
  reads: Array<{ file: string; line_start: number; line_end: number }>;
  fetched: string[];
  tokens?: { prompt?: number; completion?: number };
};

function previewToolResult(result: unknown): string {
  try {
    const s = typeof result === "string" ? result : JSON.stringify(result);
    return s.length > 200 ? s.slice(0, 200) + "..." : s;
  } catch {
    return "[unprintable]";
  }
}

export async function runAgent(input: AgentRunInput): Promise<AgentRunOutput> {
  const provider = createOpenAICompatible({
    name: "local",
    baseURL: input.cfg.modelEndpoint,
  });
  const model = provider.chatModel(input.cfg.model);

  const reads: AgentToolsCtx["reads"] = [];
  const fetched: AgentToolsCtx["fetched"] = [];
  const tools = buildTools({ repoDir: input.repoDir, reads, fetched });

  const steps: AgentStepSummary[] = [];

  const agent = new ToolLoopAgent({
    model,
    instructions: input.instructions,
    tools,
    temperature: 0.1,
    // One setting drives the per-step budget. It needs to be well above
    // the final answer cap because some models (e.g. Gemma with thinking
    // on) burn tokens reasoning before emitting a tool_call.
    maxOutputTokens: input.maxAnswerTokens ?? input.cfg.maxAnswerTokens,
    stopWhen: isStepCount(input.maxSteps ?? 25),
    // Pass-through fields to the model endpoint via the provider name
    // "local" (the openai-compatible provider merges
    // providerOptions[providerName] into the chat/completions body).
    // chat_template_kwargs.enable_thinking=false is honoured by
    // llama-server with Gemma-style chat templates; other backends
    // simply ignore unknown keys.
    providerOptions: {
      local: { chat_template_kwargs: { enable_thinking: false } },
    },
    onStepFinish: ({ toolCalls, toolResults }) => {
      const step = steps.length + 1;
      if (toolCalls && toolCalls.length > 0) {
        for (let i = 0; i < toolCalls.length; i++) {
          const call = toolCalls[i];
          if (!call) continue;
          const res = toolResults?.[i];
          steps.push({
            step,
            tool: call.toolName,
            arguments: call.input,
            result_preview:
              res && typeof res === "object" && "output" in res
                ? previewToolResult((res as { output: unknown }).output)
                : undefined,
          });
        }
      } else {
        steps.push({ step });
      }
    },
  });

  const result = await agent.generate({ prompt: input.prompt });

  return {
    answer: result.text.trim(),
    steps,
    reads,
    fetched,
    tokens: {
      prompt: result.usage?.inputTokens,
      completion: result.usage?.outputTokens,
    },
  };
}
