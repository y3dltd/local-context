import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedTarget } from "./resolve.ts";

export type CacheStatus = "hit" | "cloned" | "refreshed";

type ExecResult = { code: number; stdout: string; stderr: string };

function exec(
  cmd: string,
  args: string[],
  cwd?: string,
  timeoutMs = 120_000,
): Promise<ExecResult> {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code: code ?? -1, stdout, stderr });
    });
  });
}

export type EnsureRepoResult = {
  dir: string;
  status: CacheStatus;
  resolvedRef: string;
};

export async function ensureRepo(
  reposDir: string,
  target: ResolvedTarget,
  force = false,
): Promise<EnsureRepoResult> {
  if (!existsSync(reposDir)) mkdirSync(reposDir, { recursive: true });
  const dir = join(reposDir, target.cacheKey);
  const metaPath = join(dir, ".local-context.meta.json");

  if (existsSync(dir) && existsSync(metaPath) && !force) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
      resolvedRef: string;
    };
    return { dir, status: "hit", resolvedRef: meta.resolvedRef };
  }

  if (existsSync(dir) && force) {
    await exec("rm", ["-rf", dir]);
  }

  // Try a shallow branch/tag clone first; fall back to clone+fetch+checkout for SHAs.
  const cloneArgs = ["clone", "--depth=1"];
  if (target.refKind !== "sha" && target.refKind !== "default") {
    cloneArgs.push("--branch", target.ref);
  } else if (target.refKind === "default" && target.ref !== "HEAD") {
    cloneArgs.push("--branch", target.ref);
  }
  cloneArgs.push("--single-branch", target.url, dir);

  let res = await exec("git", cloneArgs);
  let resolvedRef = target.ref;

  if (res.code !== 0 && target.refKind === "sha") {
    // SHA: clone default, then fetch + checkout the specific SHA.
    await exec("rm", ["-rf", dir]);
    res = await exec("git", [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      target.url,
      dir,
    ]);
    if (res.code === 0) {
      const fetch = await exec(
        "git",
        ["fetch", "--depth=1", "origin", target.ref],
        dir,
      );
      if (fetch.code === 0) {
        await exec("git", ["checkout", target.ref], dir);
        resolvedRef = target.ref;
      } else {
        throw new Error(
          `git fetch ${target.ref} failed: ${fetch.stderr.trim()}`,
        );
      }
    } else {
      throw new Error(`git clone failed: ${res.stderr.trim()}`);
    }
  } else if (res.code !== 0) {
    throw new Error(
      `git clone ${target.url}@${target.ref} failed: ${res.stderr.trim()}`,
    );
  }

  // Resolve the ref we actually got, to record in metadata.
  const head = await exec("git", ["rev-parse", "HEAD"], dir);
  if (head.code === 0) resolvedRef = head.stdout.trim();

  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        project: target.name,
        url: target.url,
        ref: target.ref,
        refKind: target.refKind,
        resolvedRef,
        clonedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  return { dir, status: force ? "refreshed" : "cloned", resolvedRef };
}
