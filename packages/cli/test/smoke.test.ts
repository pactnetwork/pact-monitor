import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("smoke", () => {
  test("--version matches package.json version (no drift)", () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
    );
    const result = spawnSync("bun", ["run", "src/index.ts", "--version"], {
      cwd: join(import.meta.dir, ".."),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });
});
