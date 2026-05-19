import type { Config, ProjectEntry } from "../config.ts";

export type ResolvedTarget = {
  name: string;
  url: string;
  ref: string;
  refKind: "branch" | "tag" | "sha" | "default";
  paths: string[];
  cacheKey: string;
};

const URL_RE = /^(?:https?:\/\/|git@|git\+https?:\/\/)/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:[-+][\w.]+)?$/;

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._@+-]/g, "_");
}

function nameFromUrl(url: string): string {
  const cleaned = url
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/^git@([^:]+):/, "https://$1/");
  try {
    const u = new URL(cleaned);
    const parts = u.pathname.split("/").filter(Boolean);
    return parts.slice(-2).join("__") || "repo";
  } catch {
    return "repo";
  }
}

export function resolveTarget(
  cfg: Config,
  project: string,
  version: string | undefined,
): ResolvedTarget {
  let entry: ProjectEntry | undefined = cfg.catalog[project];
  let name = project;
  let url: string;

  if (entry) {
    url = entry.url;
  } else if (URL_RE.test(project)) {
    url = project.replace(/^git\+/, "");
    name = nameFromUrl(url);
  } else {
    throw new Error(
      `unknown project "${project}" - not in projects.json and not a git URL`,
    );
  }

  let ref: string;
  let refKind: ResolvedTarget["refKind"];

  if (!version || version === "" || version.toLowerCase() === "default") {
    ref = entry?.default_branch ?? "HEAD";
    refKind = "default";
  } else if (SHA_RE.test(version)) {
    ref = version;
    refKind = "sha";
  } else if (SEMVER_RE.test(version)) {
    const prefix = entry?.tag_prefix ?? "v";
    ref = version.startsWith(prefix) || version.startsWith("v")
      ? version
      : `${prefix}${version}`;
    refKind = "tag";
  } else {
    ref = version;
    refKind = "branch";
  }

  const cacheKey = `${sanitize(name)}@${sanitize(ref)}`;

  return {
    name,
    url,
    ref,
    refKind,
    paths: entry?.paths ?? [],
    cacheKey,
  };
}
