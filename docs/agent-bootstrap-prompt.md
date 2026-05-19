# Agent bootstrap prompt

Paste this into Claude Code, Codex, OpenCode, or another coding agent from inside a project where you want version-pinned dependency lookup.

```text
Install and use local-context for this repo.

1. Use the GitHub repo y3dltd/local-context. Check whether ~/local-context already exists. If not, clone https://github.com/y3dltd/local-context.git to ~/local-context.
2. In ~/local-context, run bun install.
3. If ~/local-context/.env does not exist, copy .env.example to .env. Prefer Ollama at MODEL_ENDPOINT=http://127.0.0.1:11434/v1 and LOCAL_CONTEXT_MODEL=qwen3:8b unless I tell you another local model endpoint.
4. Register the MCP server for the current coding agent. Detect which agent you are running under and choose the matching target:
   - Claude Code: bun bin/cli.ts install --target claude-code
   - Codex: bun bin/cli.ts install --target codex
   - OpenCode: bun bin/cli.ts install --target opencode
   - PI: bun bin/cli.ts install --target pi
   - If I explicitly want all supported local agents wired on this machine: bun bin/cli.ts install --target all
5. If the installer cannot detect or update the agent config, use the matching file in ~/local-context/adapters/ as the manual fallback:
   - Claude Code project-shared config: copy adapters/claude-code.snippet.json into the target repo's root .mcp.json.
   - Codex user config: append adapters/codex.snippet.toml to ~/.codex/config.toml.
   - OpenCode user config: merge adapters/opencode.snippet.json into ~/.config/opencode/opencode.json.
   - PI extension config: use adapters/pi.snippet.json as the manifest shape.
6. For Claude Code specifically, prefer the installer because it uses the current supported command:
   claude mcp add --scope user local-context -- bun ~/local-context/bin/server.ts
   Do not write ~/.claude/.mcp.json; current Claude Code builds do not read that file.
7. Restart the coding agent session if needed so it can see the local-context MCP server. In Claude Code, use /mcp after restart to confirm local-context is connected.
8. When this repo uses a third-party library and you need a version-specific API fact, call ask_project instead of guessing from memory or pulling broad docs.
9. Read the library version from this repo's package.json, lockfile, pyproject.toml, Cargo.toml, or equivalent. Passing version is required. If you cannot identify the version, ask me or inspect the repo first; do not call ask_project without version.
10. Ask narrow repo-search questions. Include the function, option, type, file, route, or package name I am working with. Say "definition" or "declaration" when I need the source of truth, otherwise a small local model may stop at the first usage site. Examples:
    - "Find the definition of the function that implements streamText stopWhen in ai@7.0.0-canary.142. Search packages/ai/src first. I care about isStepCount and the default step limit."
    - "In react-hook-form@7.51.0, find where useForm defines the shouldUnregister option and summarize the exact behavior."
    - "In next@canary, search packages/next for unstable_after and tell me whether it is exported. Prefer the declaration/export site over tests or docs."
    - "In zod@4.4.3, search packages/zod/src/v4 for the definition of z.email. Do not stop at a from-json-schema usage site unless the definition cannot be found."
11. If ask_project returns insufficient_context, refine the question with the exact symbol or likely path rather than doing repeated broad greps.
12. Keep the final answer short and cite the returned file:line sources.
```
