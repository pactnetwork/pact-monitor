import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Envelope } from "../lib/envelope.ts";

const MARKER = "## Paid API calls";

export async function initCommand(opts: { cwd: string; skillSrc: string; snippetSrc: string }): Promise<Envelope> {
  const skillDir = join(opts.cwd, ".claude", "skills", "pact");
  const skillFile = join(skillDir, "SKILL.md");
  if (!existsSync(skillFile)) {
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillFile, opts.skillSrc);
  }

  const claudeMd = pickClaudeMdPath(opts.cwd);
  const snippet = opts.snippetSrc.trim() + "\n";
  if (!existsSync(claudeMd)) {
    mkdirSync(dirname(claudeMd), { recursive: true });
    writeFileSync(claudeMd, snippet);
  } else {
    const cur = readFileSync(claudeMd, "utf8");
    if (!cur.includes(MARKER)) {
      writeFileSync(claudeMd, cur.replace(/\n*$/, "\n\n") + snippet);
    }
  }

  return {
    status: "ok",
    body: {
      skill_installed: skillFile,
      claude_md_updated: claudeMd,
    },
  };
}

function pickClaudeMdPath(cwd: string): string {
  const candidates = ["CLAUDE.md", "AGENTS.md"];
  for (const c of candidates) {
    if (existsSync(join(cwd, c))) return join(cwd, c);
  }
  return join(cwd, "CLAUDE.md");
}
