import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand } from "../src/cmd/init.ts";

const SKILL = "---\nname: pact\n---\n# Pact\n";
const SNIPPET = "## Paid API calls\n\nUse pact.\n";

describe("cmd/init", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pact-init-test-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("creates SKILL.md if missing", async () => {
    await initCommand({ cwd: dir, skillSrc: SKILL, snippetSrc: SNIPPET });
    expect(existsSync(join(dir, ".claude/skills/pact/SKILL.md"))).toBe(true);
  });

  test("creates CLAUDE.md if missing", async () => {
    await initCommand({ cwd: dir, skillSrc: SKILL, snippetSrc: SNIPPET });
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toContain("## Paid API calls");
  });

  test("appends to existing CLAUDE.md", async () => {
    writeFileSync(join(dir, "CLAUDE.md"), "# Existing\n\nHello.\n");
    await initCommand({ cwd: dir, skillSrc: SKILL, snippetSrc: SNIPPET });
    const after = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(after).toContain("# Existing");
    expect(after).toContain("## Paid API calls");
  });

  test("idempotent — second run does not duplicate", async () => {
    await initCommand({ cwd: dir, skillSrc: SKILL, snippetSrc: SNIPPET });
    await initCommand({ cwd: dir, skillSrc: SKILL, snippetSrc: SNIPPET });
    const md = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    const occurrences = md.split("## Paid API calls").length - 1;
    expect(occurrences).toBe(1);
  });
});
