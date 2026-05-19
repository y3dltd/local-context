# Security model

`local-context` is a local MCP server. It runs on your machine with the same
filesystem and network permissions as the user account that starts it.

Only enable it for coding agents you trust.

## What it can do

Depending on which tool is called, `local-context` can:

- clone git repositories into the configured cache directory
- read files inside cloned dependency repos
- read files inside a local repo path passed to `ask_local`
- send tool results to the configured OpenAI-compatible model endpoint
- optionally call web search providers when `TAVILY_API_KEY` or `EXA_API_KEY` is set
- optionally fetch public web pages through `web_fetch`

## Main trust boundary

The MCP client decides when to call tools and what arguments to pass. The local
model then decides which repo files to inspect through bounded `grep_repo` and
`read_file` tools.

That means the safe default is:

- use `ask_project` for third-party dependency source lookup
- pass exact versions/tags/SHAs
- only use `ask_local` on repos you are comfortable exposing to your configured model endpoint
- keep `MODEL_ENDPOINT` pointed at a local backend if you do not want code snippets leaving the machine

## Guardrails

Current guardrails include:

- `ask_project` requires an explicit version, tag, branch, or SHA
- repo reads reject path traversal
- symlinks that resolve outside the repo are rejected
- `read_file` and `grep_repo` outputs are capped
- large files are rejected by `read_file`
- web search is disabled unless a Tavily or Exa key is configured
- `web_fetch` only accepts HTTP/HTTPS URLs
- `web_fetch` rejects URL credentials
- `web_fetch` blocks private, loopback, link-local, and non-standard-port targets by default
- redirects are checked before following
- answers include `confidence` and `citation_audit` so callers can detect weak or unmatched citations

## Caveats

These are known limitations, not guarantees:

- `ask_local` can expose source under the path you pass it. Do not pass a home directory or secrets directory.
- Secret-like files inside a repo may still be readable unless excluded by the repo, future deny rules, or the caller's path choice.
- Raw git URLs allow cloning arbitrary repositories using the user's local git credentials.
- `web_fetch` SSRF protection is best-effort. DNS rebinding is not fully prevented because the runtime performs its own fetch DNS lookup after validation.
- A local model answer can still be wrong. Treat `confidence: "partial"` or `confidence: "low"` as a signal to inspect `sources` directly.
- If `MODEL_ENDPOINT` points to a hosted API, source snippets sent to the model are no longer local-only.

## Reporting security issues

Please do not open a public issue that includes secrets, private source, tokens,
or vulnerable URLs.

Preferred reporting path:

1. Use GitHub private vulnerability reporting for `y3dltd/local-context`, if available.
2. If private reporting is not available, open a public issue with a high-level description only and ask for a private contact path.

Useful details to include, without secrets:

- `local-context` commit or version
- operating system
- MCP client
- backend type, for example Ollama, llama.cpp, LM Studio, or vLLM
- which tool was called
- whether `ask_project`, `ask_local`, `web_search`, or `web_fetch` was involved
- redacted arguments and redacted output

## Supported versions

This is an early `0.x` project. Security fixes are made against the current
`main` branch until tagged releases exist.
