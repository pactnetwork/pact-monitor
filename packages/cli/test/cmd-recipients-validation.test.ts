import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recipientsCommand } from "../src/cmd/recipients.ts";

const SLUG = "validation";

function writeJsonFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pact-recipients-test-"));
  const p = join(dir, "recipients.json");
  writeFileSync(p, typeof contents === "string" ? contents : JSON.stringify(contents));
  return p;
}

function runWith(file: string) {
  return recipientsCommand({
    rpcUrl: "http://127.0.0.1:0",
    cluster: "devnet",
    slug: SLUG,
    file,
  });
}

describe("cmd/recipients --file validation", () => {
  test("file does not exist -> recipients_file_missing", async () => {
    const env = await runWith("/tmp/definitely/does/not/exist.json");
    expect(env.status).toBe("client_error");
    const body = env.body as { error: string };
    expect(body.error).toBe("recipients_file_missing");
  });

  test("file is not JSON -> recipients_file_invalid", async () => {
    const f = writeJsonFile("not json at all {{{");
    const env = await runWith(f);
    expect(env.status).toBe("client_error");
    expect((env.body as { error: string }).error).toBe("recipients_file_invalid");
  });

  test("file is JSON but not an array -> recipients_file_invalid", async () => {
    const f = writeJsonFile({ kind: "Treasury", bps: 100 });
    const env = await runWith(f);
    expect(env.status).toBe("client_error");
    expect((env.body as { error: string }).error).toBe("recipients_file_invalid");
  });

  test("empty array -> recipients_file_invalid", async () => {
    const f = writeJsonFile([]);
    const env = await runWith(f);
    expect(env.status).toBe("client_error");
    expect((env.body as { error: string }).error).toBe("recipients_file_invalid");
  });

  test("kind not in {Treasury, AffiliateAta} -> recipients_file_invalid", async () => {
    const f = writeJsonFile([{ kind: "Bogus", destination: "x", bps: 100 }]);
    const env = await runWith(f);
    expect(env.status).toBe("client_error");
    expect((env.body as { error: string }).error).toBe("recipients_file_invalid");
  });

  test("destination not base58 -> recipients_file_invalid", async () => {
    const f = writeJsonFile([
      { kind: "AffiliateAta", destination: "not-base58!@#", bps: 100 },
    ]);
    const env = await runWith(f);
    expect(env.status).toBe("client_error");
    expect((env.body as { error: string }).error).toBe("recipients_file_invalid");
  });

  test("bps > 10000 -> recipients_file_invalid", async () => {
    const f = writeJsonFile([
      {
        kind: "Treasury",
        destination: "5XyGGyazg6rGJU3Hjkrx1PDM1rBE3FraRnMauSR46rW1",
        bps: 99999,
      },
    ]);
    const env = await runWith(f);
    expect(env.status).toBe("client_error");
    expect((env.body as { error: string }).error).toBe("recipients_file_invalid");
  });

  test("sum of bps exceeds 10000 -> recipients_file_invalid", async () => {
    const f = writeJsonFile([
      { kind: "Treasury", destination: "5XyGGyazg6rGJU3Hjkrx1PDM1rBE3FraRnMauSR46rW1", bps: 5500 },
      { kind: "AffiliateAta", destination: "5XyGGyazg6rGJU3Hjkrx1PDM1rBE3FraRnMauSR46rW1", bps: 5500 },
    ]);
    const env = await runWith(f);
    expect(env.status).toBe("client_error");
    expect((env.body as { error: string }).error).toBe("recipients_file_invalid");
  });

  test("more than 8 entries -> recipients_file_invalid", async () => {
    const arr = new Array(9).fill({
      kind: "Treasury",
      destination: "5XyGGyazg6rGJU3Hjkrx1PDM1rBE3FraRnMauSR46rW1",
      bps: 100,
    });
    const f = writeJsonFile(arr);
    const env = await runWith(f);
    expect(env.status).toBe("client_error");
    expect((env.body as { error: string }).error).toBe("recipients_file_invalid");
  });

  test("valid spec without PACT_PRIVATE_KEY -> client_error (auth missing, NOT _file_invalid)", async () => {
    // Confirms validation passed and the next gate (auth key load) fires.
    const f = writeJsonFile([
      {
        kind: "Treasury",
        destination: "5XyGGyazg6rGJU3Hjkrx1PDM1rBE3FraRnMauSR46rW1",
        bps: 100,
      },
    ]);
    const oldKey = process.env.PACT_PRIVATE_KEY;
    delete process.env.PACT_PRIVATE_KEY;
    try {
      const env = await runWith(f);
      expect(env.status).toBe("client_error");
      const body = env.body as { error: string };
      // Should pass file validation and fall through to auth-missing.
      expect(body.error).toMatch(/PACT_PRIVATE_KEY/);
    } finally {
      if (oldKey !== undefined) process.env.PACT_PRIVATE_KEY = oldKey;
    }
  });
});
