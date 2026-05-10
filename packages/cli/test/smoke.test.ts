import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

describe("smoke", () => {
  test("--version prints 0.1.0", () => {
    const result = spawnSync("bun", ["run", "src/index.ts", "--version"], {
      cwd: import.meta.dir + "/..",
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.0");
  });
});
