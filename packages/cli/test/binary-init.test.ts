// Regression test for the bun-compiled binary: `pact init` must succeed
// against the actual `dist/pact` produced by `bun build --compile`.
//
// This guards against a class of bugs where skill assets (SKILL.md,
// claude-md-snippet.md) are not embedded in the bunfs virtual filesystem.
// The runtime symptom is `ENOENT: no such file or directory, open
// '/$bunfs/root/skill/SKILL.md'`. Source-only unit tests don't catch it
// because they read the files directly from disk.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BINARY = join(import.meta.dir, "..", "dist", "pact");
const SKILL_SOURCE = join(import.meta.dir, "..", "src", "skill", "SKILL.md");
const SNIPPET_SOURCE = join(import.meta.dir, "..", "src", "skill", "claude-md-snippet.md");

const hasBinary = existsSync(BINARY);
const describeIfBinary = hasBinary ? describe : describe.skip;

describeIfBinary("compiled binary: pact init", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-bin-init-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("writes SKILL.md and CLAUDE.md from bundled assets", () => {
    const result = spawnSync(BINARY, ["--json", "init"], {
      cwd: dir,
      env: { ...process.env, PACT_MAINNET_ENABLED: "1" },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    const env = JSON.parse(result.stdout.trim());
    expect(env.status).toBe("ok");

    const writtenSkill = join(dir, ".claude/skills/pact/SKILL.md");
    expect(existsSync(writtenSkill)).toBe(true);

    // Bundled SKILL.md content must match the source file byte-for-byte —
    // catches any future build step that ships a stub or empty placeholder.
    const expected = readFileSync(SKILL_SOURCE, "utf8");
    const actual = readFileSync(writtenSkill, "utf8");
    expect(actual).toBe(expected);
    expect(statSync(writtenSkill).size).toBeGreaterThan(0);

    const claudeMd = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    const expectedSnippet = readFileSync(SNIPPET_SOURCE, "utf8").trim();
    expect(claudeMd).toContain(expectedSnippet);
  });
});

if (!hasBinary) {
  // Surface a clear note when the binary hasn't been built yet so this test
  // doesn't silently no-op in environments that skip `pnpm build`.
  console.warn(
    `[binary-init.test] skipping: ${BINARY} not found. Run \`pnpm build\` first.`,
  );
}
