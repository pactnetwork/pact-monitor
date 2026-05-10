import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export type ProjectResolution =
  | { ok: true; name: string; source: "flag" | "env" | "git" | "cwd" }
  | { ok: false; reason: "no_stable_name" };

const UNSTABLE_BASENAMES = new Set(["", "/", "tmp", "var", "private", "Users"]);

export function resolveProjectName(opts: { flag?: string; cwd: string }): ProjectResolution {
  if (opts.flag) {
    return { ok: true, name: opts.flag, source: "flag" };
  }
  const env = process.env.PACT_PROJECT;
  if (env) {
    return { ok: true, name: env, source: "env" };
  }
  const git = readGitRemoteName(opts.cwd);
  if (git) {
    return { ok: true, name: git, source: "git" };
  }
  const base = basename(opts.cwd);
  if (UNSTABLE_BASENAMES.has(base)) {
    return { ok: false, reason: "no_stable_name" };
  }
  return { ok: true, name: base, source: "cwd" };
}

function readGitRemoteName(cwd: string): string | null {
  const cfg = join(cwd, ".git", "config");
  if (!existsSync(cfg)) return null;
  const txt = readFileSync(cfg, "utf8");
  const m = txt.match(/\[remote "origin"\][\s\S]*?url\s*=\s*(\S+)/);
  if (!m) return null;
  const url = m[1].trim();
  // last path segment, strip .git
  const seg = url.split(/[/:]/).pop() ?? "";
  return seg.replace(/\.git$/, "") || null;
}
