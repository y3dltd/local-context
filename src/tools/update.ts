import type { Config } from "../config.ts";
import { resolveTarget } from "../repo/resolve.ts";
import { ensureRepo } from "../repo/clone.ts";

export type UpdateInput = { project: string; version?: string };
export type UpdateOutput = {
  project: string;
  version_used: string;
  cache_dir: string;
  status: "cloned" | "refreshed" | "hit";
};

export async function updateProject(
  cfg: Config,
  input: UpdateInput,
): Promise<UpdateOutput> {
  const target = resolveTarget(cfg, input.project, input.version);
  const res = await ensureRepo(cfg.reposDir, target, true);
  return {
    project: target.name,
    version_used: `${target.ref} (${res.resolvedRef.slice(0, 7)})`,
    cache_dir: res.dir,
    status: res.status,
  };
}
