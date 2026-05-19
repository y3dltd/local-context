import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GrepHit } from "./grep.ts";

export type Chunk = {
  file: string;
  line_start: number;
  line_end: number;
  text: string;
};

const WINDOW = 14;

function mergeRanges(
  ranges: Array<[number, number]>,
): Array<[number, number]> {
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [ranges[0]!];
  for (let i = 1; i < ranges.length; i++) {
    const cur = ranges[i]!;
    const last = out[out.length - 1]!;
    if (cur[0] <= last[1] + 1) last[1] = Math.max(last[1], cur[1]);
    else out.push(cur);
  }
  return out;
}

export function buildChunks(
  repoDir: string,
  hits: GrepHit[],
  budgetBytes: number,
): Chunk[] {
  // Group hits by file, preserving file insertion order (top-scored first).
  const fileOrder: string[] = [];
  const byFile = new Map<string, Array<[number, number]>>();
  for (const h of hits) {
    if (!byFile.has(h.file)) {
      byFile.set(h.file, []);
      fileOrder.push(h.file);
    }
    const lo = Math.max(1, h.line - WINDOW);
    const hi = h.line + WINDOW;
    byFile.get(h.file)!.push([lo, hi]);
  }

  // Pre-compute merged ranges + cached file contents per file.
  type FileInfo = {
    file: string;
    ranges: Array<[number, number]>;
    cursor: number;
    lines: string[] | null;
  };
  const infos: FileInfo[] = fileOrder.map((file) => ({
    file,
    ranges: mergeRanges(byFile.get(file)!),
    cursor: 0,
    lines: null,
  }));

  const out: Chunk[] = [];
  let used = 0;

  // Round-robin across files so the budget reaches the lower-scored files
  // instead of getting eaten by a single chatty doc.
  let progress = true;
  while (progress) {
    progress = false;
    for (const info of infos) {
      if (info.cursor >= info.ranges.length) continue;
      if (info.lines === null) {
        try {
          info.lines = readFileSync(join(repoDir, info.file), "utf8").split("\n");
        } catch {
          info.cursor = info.ranges.length;
          continue;
        }
      }
      const [lo, hiRaw] = info.ranges[info.cursor]!;
      info.cursor++;
      const hi = Math.min(hiRaw, info.lines.length);
      const slice = info.lines.slice(lo - 1, hi).join("\n");
      const chunkBytes = Buffer.byteLength(slice, "utf8") + info.file.length + 16;
      if (used + chunkBytes > budgetBytes && out.length > 0) return out;
      out.push({ file: info.file, line_start: lo, line_end: hi, text: slice });
      used += chunkBytes;
      progress = true;
      if (used > budgetBytes) return out;
    }
  }
  return out;
}

export function renderChunksForPrompt(chunks: Chunk[]): string {
  const blocks: string[] = [];
  for (const c of chunks) {
    blocks.push(`### ${c.file}:${c.line_start}-${c.line_end}\n${c.text}`);
  }
  return blocks.join("\n\n");
}
