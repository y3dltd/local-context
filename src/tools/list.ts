import type { Config } from "../config.ts";
import { listCache, type CacheEntry } from "../repo/cache.ts";

export type ListOutput = {
  catalog: Array<{
    name: string;
    url: string;
    default_branch: string;
    paths: string[];
    tag_prefix?: string;
  }>;
  cached: CacheEntry[];
};

export function listProjects(cfg: Config): ListOutput {
  const catalog = Object.entries(cfg.catalog).map(([name, e]) => ({
    name,
    url: e.url,
    default_branch: e.default_branch,
    paths: e.paths ?? [],
    tag_prefix: e.tag_prefix,
  }));
  return { catalog, cached: listCache(cfg.reposDir) };
}
