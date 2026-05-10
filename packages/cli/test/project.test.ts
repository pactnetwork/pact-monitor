import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectName } from "../src/lib/project.ts";

describe("resolveProjectName", () => {
  let dir: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-cli-test-"));
    delete process.env.PACT_PROJECT;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env = { ...origEnv };
  });

  test("flag wins over env", () => {
    process.env.PACT_PROJECT = "from-env";
    expect(resolveProjectName({ flag: "from-flag", cwd: dir })).toEqual({
      ok: true,
      name: "from-flag",
      source: "flag",
    });
  });

  test("env wins over git repo", () => {
    process.env.PACT_PROJECT = "from-env";
    mkdirSync(join(dir, ".git"));
    writeFileSync(
      join(dir, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/foo/from-git.git\n`,
    );
    expect(resolveProjectName({ cwd: dir })).toEqual({
      ok: true,
      name: "from-env",
      source: "env",
    });
  });

  test("git repo wins over basename", () => {
    mkdirSync(join(dir, ".git"));
    writeFileSync(
      join(dir, ".git", "config"),
      `[remote "origin"]\n\turl = https://github.com/foo/from-git.git\n`,
    );
    expect(resolveProjectName({ cwd: dir })).toEqual({
      ok: true,
      name: "from-git",
      source: "git",
    });
  });

  test("basename when no git", () => {
    const withName = join(dir, "my-project");
    mkdirSync(withName);
    expect(resolveProjectName({ cwd: withName })).toEqual({
      ok: true,
      name: "my-project",
      source: "cwd",
    });
  });

  test("returns error when cwd is /tmp-like", () => {
    expect(resolveProjectName({ cwd: "/" })).toEqual({
      ok: false,
      reason: "no_stable_name",
    });
  });

  test("strips .git suffix from git URL", () => {
    mkdirSync(join(dir, ".git"));
    writeFileSync(
      join(dir, ".git", "config"),
      `[remote "origin"]\n\turl = git@github.com:foo/my-repo.git\n`,
    );
    const result = resolveProjectName({ cwd: dir });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.name).toBe("my-repo");
  });
});
