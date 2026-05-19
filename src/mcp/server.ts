import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../config.ts";
import { askProject } from "../tools/ask.ts";
import { askLocal } from "../tools/ask_local.ts";
import { listProjects } from "../tools/list.ts";
import { updateProject } from "../tools/update.ts";

const TOOLS = [
  {
    name: "ask_project",
    description:
      "Pinned-version library lookup. Requires version/tag/branch/SHA. Ask with exact symbol/path; say definition/declaration if usage sites are not enough. Response includes a `confidence` field (ok | partial | low) describing how well each citation matches what the agent actually read; verify against `sources` when confidence is partial or low.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description:
            "Project name from projects.json (e.g. 'ai-sdk') OR a full git URL.",
        },
        version: {
          type: "string",
          description:
            "Required exact dependency version/tag/branch/SHA from caller repo. Do not omit.",
        },
        question: {
          type: "string",
          description:
            "Narrow repo-search question: symbol/type/option + likely path. Say definition/declaration when needed.",
        },
        max_tokens: {
          type: "integer",
          minimum: 128,
          maximum: 8192,
          description:
            "Per-step generated-token cap. Default 4096; clamped 128..8192.",
        },
        max_steps: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          description:
            "Max tool-call steps. Default 25; clamped 1..25.",
        },
        debug: {
          type: "boolean",
          description:
            "When true, the response includes the full per-step tool-call trace (steps[]) and local-model token usage. Default false to save the parent agent's context window; flip on only when investigating a wrong/low-confidence answer.",
        },
      },
      required: ["project", "version", "question"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_local",
    description:
      "Ask a narrow question about the user's CURRENT working repo (not a third-party library). Pass the absolute path of the local repo root. No clone, no version pin; uses the working tree as-is, including uncommitted changes. Same response shape and `confidence` semantics as ask_project.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Absolute path to the local repo root on disk (e.g. '/home/you/my-app'). Must exist and be a directory.",
        },
        question: {
          type: "string",
          description:
            "Narrow repo-search question: symbol/type/function + likely path. Say definition/declaration when needed.",
        },
        paths: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description:
            "Optional repo-relative path hints for the first grep (e.g. ['src', 'app']). Helps the agent skip past tests and build output.",
        },
        max_tokens: {
          type: "integer",
          minimum: 128,
          maximum: 8192,
          description:
            "Per-step generated-token cap. Default 4096; clamped 128..8192.",
        },
        max_steps: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          description:
            "Max tool-call steps. Default 25; clamped 1..25.",
        },
        debug: {
          type: "boolean",
          description:
            "When true, the response includes the full per-step tool-call trace (steps[]) and local-model token usage. Default false to save the parent agent's context window; flip on only when investigating a wrong/low-confidence answer.",
        },
      },
      required: ["path", "question"],
      additionalProperties: false,
    },
  },
  {
    name: "list_projects",
    description:
      "List catalog projects and cached <project>@<version> clones.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "update_project",
    description:
      "Force refresh/re-clone for a project version or moving branch.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string" },
        version: { type: "string" },
      },
      required: ["project"],
      additionalProperties: false,
    },
  },
];

function ok(data: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function err(message: string) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

export function clampMcpInteger(
  v: unknown,
  lo: number,
  hi: number,
): number | undefined {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.max(lo, Math.min(hi, Math.floor(v)))
    : undefined;
}

export async function startServer(): Promise<void> {
  const cfg = loadConfig();
  const server = new Server(
    { name: "local-context", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (name) {
        case "ask_project": {
          if (
            typeof args.project !== "string" ||
            typeof args.version !== "string" ||
            args.version.trim().length === 0 ||
            typeof args.question !== "string"
          ) {
            return err("ask_project requires { project: string, version: string, question: string }");
          }
          const out = await askProject(cfg, {
            project: args.project,
            version: args.version,
            question: args.question,
            max_tokens: clampMcpInteger(args.max_tokens, 128, 8192),
            max_steps: clampMcpInteger(args.max_steps, 1, 25),
            debug: args.debug === true,
          });
          return ok(out);
        }
        case "ask_local": {
          if (
            typeof args.path !== "string" ||
            args.path.trim().length === 0 ||
            typeof args.question !== "string" ||
            args.question.trim().length === 0
          ) {
            return err(
              "ask_local requires { path: string (absolute, non-empty), question: string (non-empty) }",
            );
          }
          const paths = Array.isArray(args.paths)
            ? args.paths.filter(
                (p): p is string =>
                  typeof p === "string" && p.trim().length > 0,
              )
            : undefined;
          const out = await askLocal(cfg, {
            path: args.path,
            question: args.question,
            paths,
            max_tokens: clampMcpInteger(args.max_tokens, 128, 8192),
            max_steps: clampMcpInteger(args.max_steps, 1, 25),
            debug: args.debug === true,
          });
          return ok(out);
        }
        case "list_projects":
          return ok(listProjects(cfg));
        case "update_project": {
          if (typeof args.project !== "string") {
            return err("update_project requires { project: string }");
          }
          const out = await updateProject(cfg, {
            project: args.project,
            version: typeof args.version === "string" ? args.version : undefined,
          });
          return ok(out);
        }
        default:
          return err(`unknown tool: ${name}`);
      }
    } catch (e) {
      return err((e as Error).message);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
