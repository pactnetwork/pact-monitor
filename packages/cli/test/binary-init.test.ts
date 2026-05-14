// Regression test for the Node bundle: `pact init` must succeed against
// the actual `dist/pact.js` produced by `bun build --target=node`.
//
// This guards against a class of bugs where skill assets (SKILL.md,
// claude-md-snippet.md) drift out of sync with the bundle — bun's
// `import x from "./foo.md" with { type: "text" }` inlines the file at
// build time, so a stale bundle ships stale content. Source-only unit
// tests don't catch this because they read the files directly from disk.
//
// History: pre-0.2.8 this targeted `dist/pact` (a bun-compiled native
// binary). 0.2.8 collapsed to a single Node bundle (`dist/pact.js`); the
// regression model is identical — embedded asset must match source.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUNDLE = join(import.meta.dir, "..", "dist", "pact.js");
const SKILL_SOURCE = join(import.meta.dir, "..", "src", "skill", "SKILL.md");
const SNIPPET_SOURCE = join(import.meta.dir, "..", "src", "skill", "claude-md-snippet.md");

const hasBundle = existsSync(BUNDLE);
const describeIfBundle = hasBundle ? describe : describe.skip;

describeIfBundle("node bundle: pact init", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-bundle-init-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("writes SKILL.md and CLAUDE.md from bundled assets", () => {
    const result = spawnSync("node", [BUNDLE, "--json", "init"], {
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

if (!hasBundle) {
  // Surface a clear note when the bundle hasn't been built yet so this test
  // doesn't silently no-op in environments that skip `pnpm build`.
  console.warn(
    `[binary-init.test] skipping: ${BUNDLE} not found. Run \`pnpm build\` first.`,
  );
}
