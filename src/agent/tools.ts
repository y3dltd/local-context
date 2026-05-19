import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import { tool } from "ai";
import { z } from "zod";

// Hard bounds - every tool returns within these caps regardless of input.
const READ_FILE_MAX_LINES = 120;
const READ_FILE_MAX_BYTES = 8 * 1024;
const GREP_MAX_HITS = 25;
const WEB_FETCH_MAX_BYTES = 6 * 1024;
const WEB_SEARCH_MAX_RESULTS = 8;

type ExecResult = { code: number; stdout: string; stderr: string };

function exec(
  cmd: string,
  args: string[],
  cwd?: string,
  timeoutMs = 15_000,
): Promise<ExecResult> {
  return new Promise((resolveP) => {
    // stdio: stdin = "ignore" so tools like ripgrep don't read from a pipe
    // and wait for stdin input - otherwise rg with no path arg hangs forever.
    const child = spawn(cmd, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout!.on("data", (d) => (stdout += d.toString()));
    child.stderr!.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code: code ?? -1, stdout, stderr });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveP({ code: -1, stdout: "", stderr: e.message });
    });
  });
}

function safeRelative(repoDir: string, file: string): string | null {
  const abs = resolvePath(repoDir, file);
  const root = resolvePath(repoDir);
  const rel = relative(root, abs);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) return null;
  return abs;
}

// Resolve symlinks and confirm the real path is still inside the repo.
// Prevents a malicious cloned repo from exposing arbitrary host files
// via a symlink that passes the lexical safeRelative check.
function safeReal(repoDir: string, abs: string): string | null {
  let realRoot: string;
  let realAbs: string;
  try {
    realRoot = realpathSync(repoDir);
    realAbs = realpathSync(abs);
  } catch {
    return null;
  }
  const rel = relative(realRoot, realAbs);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) return null;
  return realAbs;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "").toLowerCase();
}

function isLocalHostname(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  return h === "localhost" || h.endsWith(".localhost") || h === "local" || h.endsWith(".local");
}

// Private / reserved IP ranges that an SSRF would target.
// Block both IPv4 and IPv6 equivalents. Opt out with
// LOCAL_CONTEXT_ALLOW_PRIVATE_FETCH=1 (e.g. for internal homelab use).
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 100 && b >= 64 && b <= 127 ||
    a >= 224
  );
}
function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
  if (lower.startsWith("fe80:")) return true; // link-local
  if (lower.startsWith("::ffff:")) {
    const v4 = lower.slice(7);
    return isPrivateIPv4(v4);
  }
  return false;
}
async function resolvesToPrivate(hostname: string): Promise<boolean> {
  const host = normalizeHostname(hostname);
  if (isLocalHostname(host)) return true;
  const v = isIP(host);
  if (v === 4) return isPrivateIPv4(host);
  if (v === 6) return isPrivateIPv6(host);
  try {
    const addrs = await dnsLookup(host, { all: true });
    return addrs.some((a) =>
      a.family === 4 ? isPrivateIPv4(a.address) : isPrivateIPv6(a.address),
    );
  } catch {
    return true;
  }
}

export type WebFetchTargetValidation =
  | { ok: true; url: URL; port: number }
  | { ok: false; error: string };

export async function validateWebFetchTarget(
  rawUrl: string,
  allowPrivate = process.env.LOCAL_CONTEXT_ALLOW_PRIVATE_FETCH === "1",
): Promise<WebFetchTargetValidation> {
  if (!/^https?:\/\//.test(rawUrl)) {
    return { ok: false, error: "only http/https URLs allowed" };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, error: "invalid URL" };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: "blocked: URL credentials are not allowed" };
  }

  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `blocked: invalid port ${parsed.port}` };
  }

  if (!allowPrivate && port !== 80 && port !== 443) {
    return {
      ok: false,
      error: `blocked: port ${port} is not 80/443. Set LOCAL_CONTEXT_ALLOW_PRIVATE_FETCH=1 to allow.`,
    };
  }

  if (!allowPrivate && (await resolvesToPrivate(parsed.hostname))) {
    return {
      ok: false,
      error:
        "blocked: hostname resolves to a private, loopback, or link-local address. Set LOCAL_CONTEXT_ALLOW_PRIVATE_FETCH=1 to allow.",
    };
  }

  return { ok: true, url: parsed, port };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export type AgentToolsCtx = {
  repoDir: string;
  reads: Array<{ file: string; line_start: number; line_end: number }>;
  fetched: string[];
};

export function buildTools(ctx: AgentToolsCtx) {
  return {
    grep_repo: tool({
      description:
        "Search the cloned upstream repo for a regex pattern. Returns file:line:text matches. Use this to find where a symbol, option, or phrase appears. Be specific - use the exact identifier (e.g. 'stopWhen' or 'streamText'). Use `read_file` after to read context around a hit.",
      inputSchema: z.object({
        pattern: z
          .string()
          .min(1)
          .describe(
            "Regex pattern (PCRE-style). For a literal identifier just pass the identifier. Avoid overly broad patterns like '.*' or single letters.",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "Optional subpath inside the cloned repo to restrict the search (e.g. 'packages/ai/src'). Omit to search the whole repo.",
          ),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(GREP_MAX_HITS)
          .optional()
          .describe(`Max hits to return (default 12, capped at ${GREP_MAX_HITS}).`),
      }),
      execute: async ({ pattern, path, max_results }) => {
        const cap = Math.min(max_results ?? 12, GREP_MAX_HITS);
        const args = [
          "-n",
          "--no-heading",
          "--color=never",
          "-S",
          "--max-count=2",
          "--max-filesize=400K",
          "-g",
          "!**/node_modules/**",
          "-g",
          "!**/dist/**",
          "-g",
          "!**/.git/**",
          "-e",
          pattern,
        ];
        if (path) {
          const rel = safeRelative(ctx.repoDir, path);
          if (!rel) return { error: `path '${path}' is outside the repo` };
          if (!existsSync(rel)) return { error: `path '${path}' does not exist` };
          if (!safeReal(ctx.repoDir, rel))
            return { error: `path '${path}' resolves outside the repo` };
          args.push(path);
        }
        const res = await exec("rg", args, ctx.repoDir);
        const lines = res.stdout.split("\n").filter(Boolean).slice(0, cap);
        const hits = lines.map((line) => {
          const i1 = line.indexOf(":");
          const i2 = i1 >= 0 ? line.indexOf(":", i1 + 1) : -1;
          if (i1 < 0 || i2 < 0) return { raw: line };
          return {
            file: line.slice(0, i1),
            line: Number(line.slice(i1 + 1, i2)),
            text: line.slice(i2 + 1).slice(0, 240),
          };
        });
        return { pattern, hits, truncated: lines.length >= cap };
      },
    }),

    read_file: tool({
      description:
        "Read a line range from a file in the cloned repo. Use after grep_repo to see context around a hit. Capped at 120 lines / 8 KB per call. Each returned line is prefixed with its ABSOLUTE file line number, e.g. ` 21| const guestId = ...;` - cite those numbers directly in your answer, do not count from the snippet start.",
      inputSchema: z.object({
        file: z
          .string()
          .min(1)
          .describe("Repo-relative path, e.g. 'packages/ai/src/generate-text/stream-text.ts'."),
        line_start: z
          .number()
          .int()
          .min(1)
          .describe("First line to include (1-indexed)."),
        line_end: z
          .number()
          .int()
          .min(1)
          .describe(`Last line to include. line_end - line_start must be < ${READ_FILE_MAX_LINES}.`),
      }),
      execute: async ({ file, line_start, line_end }) => {
        const abs = safeRelative(ctx.repoDir, file);
        if (!abs) return { error: `file '${file}' is outside the repo` };
        if (!existsSync(abs)) return { error: `file '${file}' does not exist` };
        // Defend against symlink escape: a malicious upstream repo could
        // include a symlink whose target is outside the clone. realpathSync
        // resolves all links; we then reverify the resolved path is still
        // inside the (realpath of the) repo root.
        const real = safeReal(ctx.repoDir, abs);
        if (!real) return { error: `file '${file}' resolves outside the repo` };
        try {
          if (statSync(real).size > 2 * 1024 * 1024)
            return { error: `file '${file}' too large (>2MB)` };
        } catch {
          return { error: `cannot stat '${file}'` };
        }
        const lines = readFileSync(real, "utf8").split("\n");
        const lo = Math.max(1, Math.min(line_start, lines.length));
        const hiRaw = Math.max(lo, Math.min(line_end, lines.length));
        const hi = Math.min(hiRaw, lo + READ_FILE_MAX_LINES - 1);
        // Prefix each line with its absolute file line number so the
        // model can cite precisely without having to mentally count
        // forward from line_start. Small models routinely miscount
        // across 30+ lines, producing citations that fall inside the
        // read range but point at wrong lines. The "N| content" format
        // matches what grep_repo already emits, so the model sees a
        // consistent shape across both tools.
        const padWidth = String(hi).length;
        let text = lines
          .slice(lo - 1, hi)
          .map((line, i) => `${String(lo + i).padStart(padWidth, " ")}| ${line}`)
          .join("\n");
        if (Buffer.byteLength(text, "utf8") > READ_FILE_MAX_BYTES) {
          text = text.slice(0, READ_FILE_MAX_BYTES) + "\n... [truncated]";
        }
        ctx.reads.push({ file, line_start: lo, line_end: hi });
        return { file, line_start: lo, line_end: hi, text };
      },
    }),

    web_search: tool({
      description:
        "Search the live web for current information (release notes, blog posts, GitHub issues). Use only when the cloned repo can't answer, e.g. to confirm the current canary state of a library. Requires TAVILY_API_KEY or EXA_API_KEY env var.",
      inputSchema: z.object({
        query: z.string().min(2).describe("Web search query."),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(WEB_SEARCH_MAX_RESULTS)
          .optional()
          .describe(`Max results to return (default 5, capped at ${WEB_SEARCH_MAX_RESULTS}).`),
      }),
      execute: async ({ query, max_results }) => {
        const cap = Math.min(max_results ?? 5, WEB_SEARCH_MAX_RESULTS);
        const tavily = process.env.TAVILY_API_KEY;
        if (tavily) {
          try {
            const res = await fetch("https://api.tavily.com/search", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                api_key: tavily,
                query,
                max_results: cap,
                search_depth: "basic",
                include_answer: false,
              }),
              signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok)
              return { error: `tavily ${res.status}: ${await res.text().catch(() => "")}` };
            const json = (await res.json()) as {
              results?: Array<{ title?: string; url?: string; content?: string }>;
            };
            return {
              provider: "tavily",
              results: (json.results ?? []).slice(0, cap).map((r) => ({
                title: r.title ?? "",
                url: r.url ?? "",
                snippet: (r.content ?? "").slice(0, 300),
              })),
            };
          } catch (e) {
            return { error: `tavily error: ${(e as Error).message}` };
          }
        }
        const exa = process.env.EXA_API_KEY;
        if (exa) {
          try {
            const res = await fetch("https://api.exa.ai/search", {
              method: "POST",
              headers: { "content-type": "application/json", "x-api-key": exa },
              body: JSON.stringify({
                query,
                numResults: cap,
                type: "neural",
                contents: { text: { maxCharacters: 300 } },
              }),
              signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok)
              return { error: `exa ${res.status}: ${await res.text().catch(() => "")}` };
            const json = (await res.json()) as {
              results?: Array<{ title?: string; url?: string; text?: string }>;
            };
            return {
              provider: "exa",
              results: (json.results ?? []).slice(0, cap).map((r) => ({
                title: r.title ?? "",
                url: r.url ?? "",
                snippet: (r.text ?? "").slice(0, 300),
              })),
            };
          } catch (e) {
            return { error: `exa error: ${(e as Error).message}` };
          }
        }
        return {
          error: "web_search disabled. Set TAVILY_API_KEY or EXA_API_KEY in env.",
        };
      },
    }),

    web_fetch: tool({
      description:
        "Fetch a URL and return its text content (HTML stripped). Capped at 6 KB. Use after web_search when a snippet looks promising.",
      inputSchema: z.object({
        url: z.string().url().describe("Absolute http(s) URL."),
      }),
      execute: async ({ url }) => {
        const allowPrivate = process.env.LOCAL_CONTEXT_ALLOW_PRIVATE_FETCH === "1";
        // Best-effort SSRF check: resolve the hostname and reject
        // private/loopback/link-local addresses before fetching.
        // NOTE: this remains susceptible to DNS rebinding because
        // fetch() does its own DNS lookup later. Closing that
        // time-of-check/time-of-use gap requires pinning the resolved
        // address (custom undici Agent / Bun fetch tls override) and is
        // outside this MVP. Treat web_fetch as best-effort against a
        // determined attacker; the citation validator is the real
        // backstop against the model acting on tainted output.
        const initial = await validateWebFetchTarget(url, allowPrivate);
        if (!initial.ok) return { url, error: initial.error };
        try {
          // Manual redirect following so we can SSRF-check every hop.
          let currentUrl = initial.url.toString();
          let res: Response | null = null;
          for (let hop = 0; hop < 4; hop++) {
            res = await fetch(currentUrl, {
              redirect: "manual",
              headers: {
                "user-agent": "local-context/0.1 (+https://github.com/y3dltd/local-context)",
                accept: "text/html,text/plain,*/*",
              },
              signal: AbortSignal.timeout(20_000),
            });
            if (res.status >= 300 && res.status < 400) {
              const loc = res.headers.get("location");
              if (!loc) break;
              const next = new URL(loc, currentUrl);
              const nextTarget = await validateWebFetchTarget(next.toString(), allowPrivate);
              if (!nextTarget.ok) {
                return {
                  url,
                  error: `redirect blocked: ${nextTarget.error}`,
                };
              }
              currentUrl = nextTarget.url.toString();
              continue;
            }
            break;
          }
          if (!res) return { url, error: "no response" };
          if (!res.ok)
            return {
              url: currentUrl,
              status: res.status,
              error: `HTTP ${res.status}`,
            };
          const ctype = res.headers.get("content-type") ?? "";
          const raw = await res.text();
          const text = /html/i.test(ctype) ? stripHtml(raw) : raw;
          const truncated = text.length > WEB_FETCH_MAX_BYTES;
          ctx.fetched.push(currentUrl);
          return {
            url: currentUrl,
            status: res.status,
            content_type: ctype,
            text: text.slice(0, WEB_FETCH_MAX_BYTES),
            truncated,
          };
        } catch (e) {
          return { url, error: (e as Error).message };
        }
      },
    }),
  };
}

export type AgentTools = ReturnType<typeof buildTools>;
