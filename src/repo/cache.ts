import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type CacheEntry = {
  cacheKey: string;
  project?: string;
  url?: string;
  ref?: string;
  resolvedRef?: string;
  clonedAt?: string;
};

export function listCache(reposDir: string): CacheEntry[] {
  if (!existsSync(reposDir)) return [];
  const out: CacheEntry[] = [];
  for (const name of readdirSync(reposDir)) {
    const full = join(reposDir, name);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const metaPath = join(full, ".local-context.meta.json");
    if (existsSync(metaPath)) {
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        out.push({ cacheKey: name, ...meta });
        continue;
      } catch {
        // fall through
      }
    }
    out.push({ cacheKey: name });
  }
  return out;
}
