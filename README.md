# local-context

`local-context` is a small MCP server you run locally.

A coding agent can ask it a narrow question about a specific library version, for example `react-hook-form@7.51.0` or `ai@7.0.0-canary.142`. `local-context` clones that exact git ref, lets a small local model search/read the source, and returns a short answer with file:line citations.

It is not a hosted docs search product. It is for cases where the parent agent needs one source-grounded fact and should not spend thousands of tokens on broad docs or stale training data.

## Current status

This is an early solo-developer release.

Tested manually on:

- Linux / WSL with Bun, git, and ripgrep.
- Ollama-compatible and llama.cpp-compatible local OpenAI endpoints.
- Small local models on narrow symbol/path questions.

Not yet fully proven:

- Native Windows.
- Private GitHub repos beyond the user's existing git credentials.
- Very large monorepos without path hints.
- Weak models that cannot call tools reliably.

Known weak spots:

- Broad questions waste steps.
- Small models sometimes stop at usage sites unless you ask for the definition/declaration.
- Generated/docs/test folders can dominate results unless you provide a likely source path.
- `confidence: "partial"` or `confidence: "low"` means the parent agent should inspect `sources`.

## When this helps

Use `local-context` when the parent agent needs a narrow fact about a dependency:

- where an option is read
- where a function/type/export is defined
- what a specific version does
- whether a symbol exists in a canary or pinned commit

Do not use it for:

- broad conceptual explanations
- general programming advice
- code review of the current diff
- questions where you do not know the dependency version yet

## Why this exists

The parent agent often needs an implementation fact, not a documentation bundle. Docs can be too broad, search results can mix versions, and model memory is often stale. `local-context` trades a few local-model tool steps for a compact answer grounded in the exact git ref.

The typical pattern today:

> Claude Code: needs to know how `streamText` is wired in `ai@7.0.0-canary.142`.
> Pulls thousands of tokens of docs/search output into its window.
> Reads two paragraphs of it.
> Answers the user.

`local-context` flips this around:

> Claude Code: calls `ask_project({project: "ai-sdk", version: "7.0.0-canary.142", question: "..."})`.
> Local sidecar clones the pinned ref.
> A small local model uses `grep_repo` and `read_file` to navigate the source.
> The parent agent receives a compact answer plus citations.

## What the parent agent actually sees

For the same question:

| Source | Tokens delivered to parent agent |
| --- | --- |
| Context7 `query-docs` (typical library question) | 3,500 to 10,000 |
| `local-context` full response (with debug step trace) | ~380 |
| `local-context` lean response (`answer + sources + version`) | ~70 |

The heavy lifting (the multi-step agent loop, the tool results, the raw source excerpts) happens inside the *small* model's context window. None of it bills against the parent agent's quota.

## How it works

```
┌────────────────────┐                                 ┌──────────────────────┐
│  Claude Code /     │  ── ask_project ─────▶          │  local-context (MCP) │
│  Codex / OpenCode  │  ◀──── compact, cited ──────    │  (this repo)         │
└────────────────────┘                                 └──────────┬───────────┘
                                                                  │
                                                                  ▼
                                            ┌──────────────────────────────┐
                                            │  ToolLoopAgent (AI SDK v7)   │
                                            │  + grep_repo / read_file /   │
                                            │    web_search / web_fetch    │
                                            └──────────────┬───────────────┘
                                                           │ OpenAI-compatible HTTP
                                                           ▼
                                            ┌──────────────────────────────┐
                                            │  Local LLM endpoint:         │
                                            │  llama.cpp / Ollama /        │
                                            │  LM Studio / vLLM / ...      │
                                            └──────────────────────────────┘
                                                           │
                                                           ▼
                                            ┌──────────────────────────────┐
                                            │  Version-pinned cache:       │
                                            │   repos/<project>@<version>/ │
                                            └──────────────────────────────┘
```

1. The parent agent calls the MCP tool `ask_project` with `{ project, version, question }`. `version` is required; read it from the caller repo's dependency files rather than omitting it.
2. The sidecar resolves the project (`projects.json` catalogue or a raw git URL), and clones the exact tag, branch, or commit into `repos/<project>@<version>/`. Subsequent calls hit the cache.
3. A `ToolLoopAgent` (AI SDK v7) instructs the small model to use `grep_repo`, `read_file`, and optionally `web_search` / `web_fetch` until it has a citeable answer or runs out of steps.
4. The server audits each citation in the answer against the files the agent actually read and returns the prose plus a `confidence` signal (`ok` / `partial` / `low`). The parent agent decides whether to act on the answer directly or check the listed sources.

## Backends

Anything that speaks an OpenAI-compatible `/v1/chat/completions` endpoint should work. Set `MODEL_ENDPOINT` and `LOCAL_CONTEXT_MODEL` to the endpoint and model you actually run.

The default config in `.env.example` points at **Ollama**, because it is the lowest-friction way to get started. If you want maximum tokens-per-second on a given GPU, **llama.cpp** with a quantised GGUF is the right backend; the trade-off is one more setup step.

| Backend | URL | Model name | Notes |
| --- | --- | --- | --- |
| Ollama (default) | `http://127.0.0.1:11434/v1` | e.g. `qwen3:8b` | easiest to install and pull models |
| llama.cpp `llama-server` | `http://127.0.0.1:8088/v1` | whatever you pass to `--alias` | best raw performance per GB of VRAM |
| LM Studio | `http://127.0.0.1:1234/v1` | the loaded model name | GUI, OS X / Windows friendly |
| vLLM | `http://127.0.0.1:8000/v1` | the served model name | best if you already run vLLM for batch |
| Any other OpenAI-compatible server | your URL | your model | works as long as `/v1/chat/completions` is honoured |

Pick a model that is good at tool calling. In practice that means an instruct-tuned model from a recent family (Qwen 3, Llama 3.x, Mistral, Gemma 3+). Small models can work for simple symbol lookups; 7B-8B models have been more reliable in testing. For a 12 GB consumer GPU, `qwen3:8b` is a sensible starting point.

## Install

Requires `bun` >= 1.1, `git`, and `rg` (ripgrep) on `PATH`.

```bash
git clone https://github.com/y3dltd/local-context.git
cd local-context
bun install
cp .env.example .env       # then edit to point at your model endpoint
bun run typecheck
```

The server explicitly loads `<repo>/.env` on startup (existing process env wins), so this works correctly even when the MCP server is launched from a different working directory by Claude Code, Codex, OpenCode, or PI. The llama.cpp helper script also sources the same file.

## Start your local model

### Ollama (recommended for getting started)

```bash
ollama serve                                  # if not already running
ollama pull qwen3:8b                  # any tool-calling model works
```

Then in your `.env` (already the default from `.env.example`):

```env
MODEL_ENDPOINT=http://127.0.0.1:11434/v1
LOCAL_CONTEXT_MODEL=qwen3:8b
```

### llama.cpp (recommended for raw performance)

```bash
# adjust the path / model to your build
llama-server \
  -m /path/to/your-model.gguf \
  --host 127.0.0.1 --port 8088 \
  --ctx-size 8192 \
  --n-gpu-layers 99 \
  --alias my-local-model \
  --jinja
```

A convenience script is included for the common case (the `--alias` defaults to whatever `LOCAL_CONTEXT_MODEL` is set to, so the two sides stay in sync):

```bash
LLAMA_MODEL=/path/to/your.gguf bash scripts/start-llama.sh
```

And in your `.env`:

```env
MODEL_ENDPOINT=http://127.0.0.1:8088/v1
LOCAL_CONTEXT_MODEL=my-local-model
```

### LM Studio

Start the local server from the UI ("Local Server" tab), then:

```bash
export MODEL_ENDPOINT=http://127.0.0.1:1234/v1
export LOCAL_CONTEXT_MODEL="qwen2.5-coder-7b-instruct"
```

## Register the MCP server with your coding agent

```bash
bun bin/cli.ts install --target claude-code
bun bin/cli.ts install --target codex
bun bin/cli.ts install --target opencode
bun bin/cli.ts install --target pi      # best-effort; PI MCP support is still maturing
# or install everywhere
bun bin/cli.ts install --target all
```

The installer is idempotent and writes a timestamped backup of any config it touches.

For Claude Code, the installer uses the supported user-scope command:

```bash
claude mcp add --scope user local-context -- bun /absolute/path/to/local-context/bin/server.ts
```

That makes `local-context` available across Claude Code projects after restarting the Claude Code session. If you would rather wire it up by hand for one shared project, copy `adapters/claude-code.snippet.json` into that project's root `.mcp.json`. The old `~/.claude/.mcp.json` path is not used by current Claude Code builds.

For other agents, copy the snippet from `adapters/<agent>.snippet.*` into the relevant config file. Adapter formats change, so treat these as tested examples rather than a guarantee that every future agent build still reads the same layout.

## Copy-paste prompt for your coding agent

If you want Claude Code, Codex, OpenCode, or another coding agent to install and use this from inside a project, use the prompt in [`docs/agent-bootstrap-prompt.md`](docs/agent-bootstrap-prompt.md).

The important part: phrase questions like repo searches, not broad documentation requests. “Find the definition of the function that does XYZ”, “look for option ABC under package/path”, or “search package/path for SymbolName and prefer the declaration over usage sites” gives the small model enough direction to avoid wasting steps on generic greps.

## Tools the parent agent gets

| Tool | Arguments | Result |
| --- | --- | --- |
| `ask_project` | `{ project, version, question, max_tokens?, max_steps?, debug? }` | `{ answer, sources, fetched, version_used, cache_status, status, confidence, citation_audit }` (+ `steps`, `tokens` when `debug: true`) |
| `ask_local` | `{ path, question, paths?, max_tokens?, max_steps?, debug? }` | `{ answer, sources, fetched, repo_path, status, confidence, citation_audit }` (+ `steps`, `tokens` when `debug: true`) |
| `list_projects` | `{}` | curated catalogue + cached `<project>@<version>` directories |
| `update_project` | `{ project, version? }` | forces a fresh clone of that version |

`ask_project` is for **third-party libraries** at a pinned version (clones from git into a local cache). `ask_local` is for the **user's own working repo** that already lives on disk (no clone, no version pin, uses the working tree including uncommitted changes). Same agent loop and the same `confidence` / `citation_audit` machinery in both.

A SKILL file is also included at `skills/local-context/SKILL.md` so Claude Code and PI know *when* to reach for these tools rather than fetching docs or guessing from training data.

### `ask_project` arguments

* `project` (required): a name from `projects.json` (e.g. `ai-sdk`, `react-hook-form`, `next`, `tanstack-query`, `drizzle-orm`, `zod`) or a raw git URL (e.g. `https://github.com/your-org/your-lib.git`).
* `version` (required): a tag, branch, or commit SHA. Read it from the caller repo's `package.json`, lockfile, or equivalent. The tool rejects missing versions so it does not silently answer from a moving default branch.
* `question` (required): the narrow factual question. Be specific. Mention the export, type, option, and likely source path you care about.
* `max_tokens` (optional, default 4096, clamped 128..8192): per-step generated-output budget for the local model. This is not the repo context budget; extensive repo/doc traversal is controlled mainly by `max_steps` plus the capped tool outputs.
* `max_steps` (optional, default 25, clamped 1..25): how many tool-call rounds the agent gets. The default is the cap; small models often need more than ten steps to chase a type across several files, and the per-step output cap plus capped tool outputs already bound the wall-clock cost.
* `debug` (optional, default `false`): when `true` the response includes `steps` (full per-step tool-call trace) and `tokens` (local-model usage). Default is off because that trace can be the bulk of the response payload and the whole point of `local-context` is to spend parent-agent context only on the answer itself. Flip it on when investigating a low-confidence answer or tuning prompts.

### Example call

```jsonc
// Parent agent calls
{
  "name": "ask_project",
  "arguments": {
    "project": "ai-sdk",
    "version": "7.0.0-canary.142",
    "question": "What does stopWhen do in streamText, and how does isStepCount relate to it?"
  }
}
```

```jsonc
// local-context returns
{
  "answer": "stopWhen is an Arrayable<StopCondition> on streamText that decides when the stream stops [packages/ai/src/agent/tool-loop-agent-settings.ts:78]. The default is isStepCount(20), which fires once that many tool-call steps have completed [packages/ai/src/agent/tool-loop-agent.ts:121].",
  "sources": [
    { "file": "packages/ai/src/agent/tool-loop-agent-settings.ts", "line_start": 78, "line_end": 81 },
    { "file": "packages/ai/src/agent/tool-loop-agent.ts", "line_start": 119, "line_end": 124 }
  ],
  "fetched": [],
  "version_used": "ai@7.0.0-canary.142 (aa5a1e5)",
  "cache_status": "hit",
  "status": "ok",
  "confidence": "ok",
  "citation_audit": {
    "[packages/ai/src/agent/tool-loop-agent-settings.ts:78]": "exact: packages/ai/src/agent/tool-loop-agent-settings.ts:78-81",
    "[packages/ai/src/agent/tool-loop-agent.ts:121]": "exact: packages/ai/src/agent/tool-loop-agent.ts:119-124"
  }
}
```

Pass `debug: true` and the response also includes `steps` (full per-step tool-call trace) and `tokens` (local-model usage). Default-lean responses are typically 70-200 tokens; the debug trace is what pushed the previously-measured response to ~380 tokens. The big numbers a debug response shows for `tokens` are what the *small* model spent — the parent agent only pays for the JSON it receives.

### `ask_local` arguments

* `path` (required): absolute path to a repo root on disk (e.g. `/home/you/my-app`). Must exist and be a directory. Symlinked roots are followed once to their real path; symlinks *inside* the repo that escape its boundary are rejected by the read/grep tools.
* `question` (required): same shape as `ask_project`'s question. Name the function, type, or option you care about and say "definition" if usage sites are not enough.
* `paths` (optional): repo-relative path hints for the agent's first grep, e.g. `["src", "app"]`. Useful if the repo has obvious build output or tests that would otherwise dominate early results.
* `max_tokens`, `max_steps`, `debug`: same semantics and bounds as `ask_project`.

### `ask_local` example

```jsonc
// Parent agent calls
{
  "name": "ask_local",
  "arguments": {
    "path": "/home/you/my-app",
    "question": "Find the function that processes incoming order webhooks and tell me which middleware it calls.",
    "paths": ["src/server"]
  }
}
```

```jsonc
// local-context returns
{
  "answer": "processOrder receives the webhook and calls verifyShopifyHmac before persisting [src/server/orders.ts:42-78]. The middleware itself lives in [src/middleware/hmac.ts:14-31].",
  "sources": [
    { "file": "src/server/orders.ts", "line_start": 42, "line_end": 78 },
    { "file": "src/middleware/hmac.ts", "line_start": 14, "line_end": 31 }
  ],
  "fetched": [],
  "repo_path": "/home/you/my-app",
  "status": "ok",
  "confidence": "ok",
  "citation_audit": { /* ... */ },
  "tokens": { "prompt": 5200, "completion": 180 }
}
```

`ask_local` does not include `version_used` or `cache_status`; the answer is whatever is on disk *now*. Two calls in quick succession can return different lines for the same file if you are editing between them.

## Configuration

Order of precedence: env vars (or `.env`) beat `~/.local-context.json` beats defaults.

The recommended pattern is `.env` next to the repo, copied from `.env.example`. There is no fallback default for `LOCAL_CONTEXT_MODEL`, because the right value depends entirely on which backend you are running; the server fails fast with a clear message if it is not set.

Supported variables (full list with comments in `.env.example`):

| Variable | Purpose |
| --- | --- |
| `MODEL_ENDPOINT` | OpenAI-compatible URL of your local LLM (also accepts `LOCAL_CONTEXT_MODEL_ENDPOINT` or `OPENAI_BASE_URL`). |
| `LOCAL_CONTEXT_MODEL` | Model name your endpoint serves (also accepts `MODEL_NAME` or `OPENAI_MODEL`). |
| `LOCAL_CONTEXT_REPOS_DIR` | Where the version-pinned upstream clones live. Defaults to `<repo>/repos`. |
| `TAVILY_API_KEY` | Enables the `web_search` tool via Tavily. |
| `EXA_API_KEY` | Enables `web_search` via Exa if no Tavily key is set. |

A `~/.local-context.json` is also honoured for per-user overrides that do not belong in env:

```json
{
  "modelEndpoint": "http://127.0.0.1:11434/v1",
  "model": "qwen3:8b",
  "reposDir": "/var/cache/local-context/repos",
  "maxAnswerTokens": 4096
}
```

## Example measurement

Concrete numbers from a recent test against `ai@7.0.0-canary.142`:

* Parent agent sent: 1 tool call (`ask_project`) of about 80 tokens.
* Parent agent received: roughly 380 tokens of response (full trace) or 70 tokens trimmed.
* Local small model used: 7,044 prompt + 238 completion tokens. None of which the parent paid for.
* End-to-end latency after the clone cache was warm: 2.9 seconds.

This is one measurement, not a benchmark suite. The same question through broad docs/search output can easily return thousands of tokens of mixed examples and docs, but exact numbers depend on the backend, model, cache state, question, and library.

### What was actually under test

Those numbers were measured with **`gemma-4-E2B` (Q4_K_M) running on `llama.cpp` with `--ctx-size 8192` on a single RTX 3060**, not with the Ollama default this repo now recommends. `qwen3:8b` was not benchmarked here; it is the suggested starting point because it has a stronger tool-calling reputation in the 7-8B class and is easier to install. Expect different (usually better) answer quality and somewhat different token counts on it. If you want to reproduce the numbers above exactly, run `gemma-4-E2B` on llama.cpp.

## Catalogue and adding projects

`projects.json` ships with a handful of common targets:

* `ai-sdk` (vercel/ai)
* `react-hook-form`
* `next` (vercel/next.js)
* `tanstack-query`
* `drizzle-orm`
* `zod`

Add a new one by appending to the `projects` object:

```jsonc
{
  "projects": {
    "shadcn-ui": {
      "url": "https://github.com/shadcn-ui/ui",
      "default_branch": "main",
      "paths": ["apps/www/content", "packages"],
      "tag_prefix": "v"
    }
  }
}
```

`paths` is an optional hint that gets passed to the agent's first grep. `tag_prefix` lets you accept short versions like `5.0.39` and have the sidecar look up `ai@5.0.39` or `v5.0.39` as appropriate.

You can also skip the catalogue entirely and pass a raw git URL as `project`. The cache key falls back to a sanitised form of the URL.

## Roadmap

* **Include specific files in the small model's context.** Pass `files: ["path/to/a.ts", "path/to/b.ts"]` in `ask_project` to seed the agent with files the parent already knows are relevant. This skips an exploration step and is especially useful when the parent has already read the file once.
* **More backends out of the box.** Adapters for popular self-hosted endpoints (text-generation-webui, TGI) with their quirks worked around.
* **Optional hybrid search.** Grep is good; for fuzzier "explain this concept" questions an embedding pass on the cached repo would help. Same MCP surface, swappable underneath.
* **Per-project model overrides.** Use a coder-tuned 7B for `next` and a tiny 2B for `zod`. Configured in `projects.json`.
* **Caching of small model answers.** A SHA of `{project, version, question}` so identical follow-up questions cost zero tokens.

## Limitations and honest caveats

* Small models occasionally substitute a name they "remember" for what the source actually shows. The system prompt is explicit about copying names verbatim from tool results, and every response includes a `confidence` flag (`ok` / `partial` / `low`) plus a `citation_audit` so the parent agent can spot the suspect citations cheaply. Treat `partial` and `low` answers as worth verifying against `sources` rather than throwing them out.
* Tool calling reliability is model-dependent. Anything below about 2B parameters is unlikely to maintain a coherent multi-step loop. Pick an instruct-tuned model from a recent family.
* The cloned upstream repo lives at the commit you ask for. If a tag does not exist the call fails clearly rather than silently using `HEAD`.
* `web_search` requires an API key for Tavily or Exa. Without one, the agent can still answer from the cloned source; it just cannot reach the live web.
* `web_fetch` blocks URL credentials, non-standard ports, and private/loopback/link-local targets by default. This is best-effort SSRF protection because normal fetch still performs its own DNS lookup; only enable `LOCAL_CONTEXT_ALLOW_PRIVATE_FETCH=1` for trusted local/homelab use.
* PI MCP support is still maturing. The installer drops a manifest in `~/.pi/agent/extensions/local-context/` but treat that adapter as best-effort.

## Layout

```
local-context/
├── bin/           # MCP stdio entry + CLI
├── src/
│   ├── agent/     # ToolLoopAgent, tools (grep/read/web_search/web_fetch)
│   ├── repo/      # version-aware clone + cache
│   ├── retrieve/  # legacy single-shot grep + chunking
│   ├── mcp/       # MCP server wiring
│   └── tools/     # MCP tool implementations (ask_project, list_projects, update_project)
├── skills/local-context/   # SKILL.md for Claude Code / PI
├── adapters/               # per-agent config snippets
├── scripts/                # llama.cpp helper
└── projects.json           # curated project catalogue
```

## Contributing

Bug reports and small PRs are welcome. The most useful contributions right now are:

* New entries in `projects.json` for libraries the catalogue does not yet cover.
* Adapter tweaks if your coding agent's config layout changes.
* Real-world question / answer pairs that the small model gets wrong, so the system prompt and retrieval heuristics can be tuned.

Run `bun run typecheck` before sending anything. The codebase is intentionally small and dependency-light; please keep it that way.

Run the focused unit tests as well:

```bash
bun run test
```

## Licence

MIT.
