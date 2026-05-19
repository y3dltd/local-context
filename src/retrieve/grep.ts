import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const STOP = new Set([
  "the","a","an","of","to","in","on","for","and","or","is","are","was","were",
  "be","been","being","what","which","who","whom","whose","when","where","why",
  "how","do","does","did","done","this","that","these","those","it","its","with",
  "from","by","as","at","into","onto","about","i","you","we","they","he","she",
  "their","my","your","our","using","use","used","return","returns","function",
  "method","api","docs","doc","help","please","need","want","tell","me","can",
  "should","would","could","may","might","work","works","working","new","old",
  "set","get","make","made","plus","minus","also","just","then","than","there",
  "here","up","down","out","over","under","again","still","like","really",
]);

function tokenize(question: string): string[] {
  const idTokens = new Set<string>();
  const words = question
    .replace(/`/g, " ")
    .split(/[^A-Za-z0-9_$@./-]+/)
    .map((w) => w.trim())
    .filter(Boolean);
  for (const w of words) {
    // PascalCase identifier: require >=2 uppercase letters so plain English
    // words like "How", "What", "I" don't get treated as code identifiers.
    const uppers = (w.match(/[A-Z]/g) ?? []).length;
    if (/^[A-Z][A-Za-z0-9_]*$/.test(w) && uppers >= 2) idTokens.add(w);
    else if (/^[a-z][A-Za-z0-9_]*$/.test(w) && /[A-Z]/.test(w)) idTokens.add(w);
    else if (/^[a-z]+(_[a-z0-9]+)+$/.test(w)) idTokens.add(w);
    else if (/[./]/.test(w) && /[a-zA-Z]/.test(w)) idTokens.add(w);
  }
  const plainTokens = words
    .map((w) => w.toLowerCase())
    .filter(
      (w) =>
        w.length >= 3 &&
        !STOP.has(w) &&
        !/^\d+$/.test(w) &&
        !idTokens.has(w),
    );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...idTokens, ...plainTokens]) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
    if (out.length >= 8) break;
  }
  return out;
}

const PATH_PRIORITY: Array<{ pattern: RegExp; score: number }> = [
  { pattern: /(^|\/)README(\.[a-z]+)?$/i, score: 100 },
  { pattern: /(^|\/)docs?\//i, score: 80 },
  { pattern: /(^|\/)examples?\//i, score: 70 },
  { pattern: /(^|\/)content\//i, score: 70 },
  { pattern: /\.mdx?$/i, score: 60 },
  { pattern: /(^|\/)src\//i, score: 50 },
  { pattern: /(^|\/)packages\/[^/]+\/src\//i, score: 50 },
  { pattern: /\.d\.ts$/i, score: 55 },
  { pattern: /\.(ts|tsx|js|jsx|mjs|py|go|rs)$/i, score: 30 },
  { pattern: /(^|\/)tests?\//i, score: -50 },
  { pattern: /(^|\/)__tests__\//i, score: -50 },
  { pattern: /\.test\.[a-z]+$/i, score: -50 },
  { pattern: /\.spec\.[a-z]+$/i, score: -50 },
  { pattern: /(^|\/)node_modules\//, score: -1000 },
  { pattern: /(^|\/)dist\//, score: -500 },
  { pattern: /(^|\/)build\//, score: -500 },
  { pattern: /\.min\.[a-z]+$/, score: -500 },
];

function scorePath(path: string): number {
  let s = 0;
  for (const { pattern, score } of PATH_PRIORITY) if (pattern.test(path)) s += score;
  return s;
}

// Strong boost when a file's basename (or its parent directory) directly
// references a token from the query - e.g. `generate-text.ts` for a
// question about `generateText`. This consistently beats README noise.
function basenameBoost(path: string, tokens: string[]): number {
  const lower = path.toLowerCase();
  const parts = lower.split("/");
  const base = parts[parts.length - 1] ?? "";
  const parent = parts.length >= 2 ? parts[parts.length - 2] ?? "" : "";
  const baseNoExt = base.replace(/\.[a-z0-9]+$/i, "");
  let boost = 0;
  for (const tRaw of tokens) {
    const t = tRaw.toLowerCase();
    if (t.length < 3) continue;
    // camelCase to kebab-case (generateText becomes generate-text)
    const kebab = tRaw.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    // Crude singular form: "steps" -> "step", "options" -> "option".
    const singular = t.endsWith("s") && t.length > 3 ? t.slice(0, -1) : t;
    const kebabSingular =
      kebab.endsWith("s") && kebab.length > 3 ? kebab.slice(0, -1) : kebab;
    const candidates = new Set([t, kebab, singular, kebabSingular]);
    for (const c of candidates) {
      if (baseNoExt === c) boost += 200;
      else if (baseNoExt.includes(c)) boost += 90;
      else if (parent === c) boost += 80;
      else if (parent.includes(c)) boost += 40;
    }
  }
  return boost;
}

export type GrepHit = { file: string; line: number; text: string; score: number };

type ExecResult = { code: number; stdout: string };

function exec(
  cmd: string,
  args: string[],
  cwd?: string,
  timeoutMs = 15_000,
): Promise<ExecResult> {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code: code ?? -1, stdout });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolveP({ code: -1, stdout: "" });
    });
  });
}

export async function searchRepo(
  repoDir: string,
  question: string,
  preferredPaths: string[] = [],
  maxFiles = 6,
): Promise<{ tokens: string[]; hits: GrepHit[] }> {
  const tokens = tokenize(question);
  if (tokens.length === 0) return { tokens, hits: [] };

  const pattern = tokens.map((t) => t.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")).join("|");
  const args = [
    "-n",
    "--no-heading",
    "--color=never",
    "-S",
    "--max-count=30",
    "--max-filesize=400K",
    "-g",
    "!**/node_modules/**",
    "-g",
    "!**/dist/**",
    "-g",
    "!**/build/**",
    "-g",
    "!**/.git/**",
    "-e",
    pattern,
  ];
  // rg returns exit code 2 (treated as error) if any path arg is missing,
  // even when other paths do produce hits. Filter to paths that exist so a
  // catalog entry like ["src","packages"] still works on monorepos that
  // only have "packages".
  const existingPaths = preferredPaths.filter((p) =>
    existsSync(join(repoDir, p)),
  );
  if (existingPaths.length > 0) {
    for (const p of existingPaths) args.push(p);
  }

  const res = await exec("rg", args, repoDir);
  // rg exit code 1 means "no matches", which is fine - return empty.
  // Other non-zero codes with no stdout are real errors; treat as no hits.
  if (!res.stdout) return { tokens, hits: [] };

  const byFile = new Map<string, GrepHit[]>();
  for (const line of res.stdout.split("\n")) {
    if (!line) continue;
    const idx1 = line.indexOf(":");
    if (idx1 < 0) continue;
    const idx2 = line.indexOf(":", idx1 + 1);
    if (idx2 < 0) continue;
    const file = line.slice(0, idx1);
    const lineNum = Number(line.slice(idx1 + 1, idx2));
    const text = line.slice(idx2 + 1);
    if (!Number.isFinite(lineNum)) continue;
    const arr = byFile.get(file) ?? [];
    // Skip hits within 40 lines of an existing hit in the same file: they
    // would just merge into the same chunk window anyway, and we want
    // coverage spread across the file. 40 > 2*WINDOW (28) so neighbouring
    // chunks won't touch either.
    if (arr.some((h) => Math.abs(h.line - lineNum) < 40)) continue;
    arr.push({ file, line: lineNum, text, score: 0 });
    byFile.set(file, arr);
  }

  const scored: Array<{ file: string; score: number; hits: GrepHit[] }> = [];
  for (const [file, hits] of byFile) {
    const baseScore = scorePath(file);
    const nameBoost = basenameBoost(file, tokens);
    const tokenBonus = hits.length * 5;
    scored.push({ file, score: baseScore + nameBoost + tokenBonus, hits });
  }
  scored.sort((a, b) => b.score - a.score);

  const top = scored.slice(0, maxFiles);
  const allHits: GrepHit[] = [];
  for (const { file, score, hits } of top) {
    for (const h of hits) allHits.push({ ...h, file, score });
  }
  return { tokens, hits: allHits };
}
