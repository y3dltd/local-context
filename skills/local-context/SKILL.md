---
name: local-context
version: 0.1.0
description: Use for narrow, source-grounded code questions. ask_project for pinned third-party library facts (clones the exact version); ask_local for questions about the user's CURRENT working repo (no clone, uses working tree). Returns short [file:line] cited answers with a confidence signal. Prefer over broad docs or memory.
requires:
  bins: ["bun", "git", "rg"]
  mcp: ["local-context"]
---

# local-context: source-grounded Q&A

Two entry points depending on which repo you are asking about.

## ask_project — third-party library, pinned version

Use for facts about a library the user depends on. Clones the exact version into a local cache.

```jsonc
ask_project({
  project: "ai-sdk",           // catalog name OR full git URL
  version: "5.0.39",            // REQUIRED: exact version from package.json / lockfile
  question: "Find the definition of streamText under packages/ai/src and tell me its return type and helpers."
})
```

Rules:
- `version` is required. Read it from package.json/lockfile/pyproject/Cargo/etc.; never use "latest" or omit.
- Tags, branches, and SHAs work.
- Ask like repo search: include symbol/type/option and likely path.
- Say `definition`, `declaration`, `implementation`, or `export site` when usage sites are not enough.
- Prefer path anchors like `packages/zod/src/v4`.
- When asking the model to cite, phrase it as "cite as [path:line]" or just say "with citations" — do NOT write "[file:line]" in your question. Small models copy that template literally and emit `[file:src/foo.ts:42]`, which the audit can still parse (we tolerate the prefix) but the bare form is cleaner.

## ask_local — user's current working repo

Use for questions about the user's own code: "where is `processOrder` defined?", "what does our `validateInput` middleware do?", "show me where this option is read." No clone, no version pin; uses the working tree as it is on disk, including uncommitted changes.

```jsonc
ask_local({
  path: "/home/you/my-app",                // ABSOLUTE path to the local repo root
  question: "Find the function that handles incoming order webhooks and tell me which middleware it calls.",
  paths: ["src", "app"]                    // optional first-grep hints
})
```

Rules:
- `path` must be absolute and point at an existing directory.
- Same prompting style as ask_project: name the symbol/function, say "definition" if usage sites are not enough.
- The agent cannot read outside `path` (symlinks that escape are rejected).
- Reads are live: editing files between calls will change the answer.

## When to pick which

| The user asked about | Use |
| --- | --- |
| A library named in their dependency manifest | `ask_project` |
| A function/file/option in the repo you are currently working in | `ask_local` |
| A general programming concept | neither — answer directly |
| Code review of the user's own diff | neither — review directly |

### Reading the response

```jsonc
{
  "answer": "...prose with [file:line] citations...",
  "sources": [{ "file": "...", "line_start": 130, "line_end": 160 }],
  "fetched": ["https://..."],
  "version_used": "5.0.39 (a1b2c3d)",
  "cache_status": "hit" | "cloned" | "refreshed",
  "status": "ok" | "insufficient_context" | "error",
  "confidence": "ok" | "partial" | "low",
  "citation_audit": { "[file:line]": "exact | suffix | ambiguous | no matching read" }
  // steps and tokens are only present when debug: true was passed.
}
```

Pass `debug: true` if you need the full per-step tool-call trace (e.g. to investigate a `low` confidence answer). By default we omit `steps` and `tokens` from the response to keep the parent agent's context budget small. The point of this whole tool is to save you tokens.

Two independent signals. `status` is about whether the agent ran; `confidence` is about whether the cited claims are verifiable. They can disagree (e.g. `status: "ok"` + `confidence: "low"` means the agent finished and gave you an answer, but at least one citation does not match anything it actually read).

- `status`:
  - `ok`: the agent ran to completion.
  - `insufficient_context`: the model itself declared it could not answer. Refine the question or call `update_project` and retry.
  - `error`: the clone, local model, or tool loop failed. Fall back and tell the user.
- `confidence`:
  - `ok`: every citation matches a recorded `read_file` exactly. Treat as verified against on-disk source.
  - `partial`: at least one citation was matched via an unambiguous suffix (the model wrote `stream-text.ts` and only one read ended with that path). Usually fine; glance at `sources` if it matters.
  - `low`: at least one citation could not be matched, or there are no citations. Do not treat the prose as ground truth — read the files in `sources` directly, or re-ask with a narrower question.

How to use them together: trust the answer when **both** are `ok`. Verify against `sources` when `confidence` is `partial` or `low`, regardless of `status`. Treat `status: error` as no answer at all.

The `citation_audit` map explains each citation, so you can verify the suspect ones cheaply.

`ask_local` returns the same shape minus `version_used` / `cache_status` and plus a `repo_path` field with the resolved absolute path.

Companion tools (third-party flow only): `list_projects`, `update_project`.
