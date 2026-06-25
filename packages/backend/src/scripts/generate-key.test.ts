// Smoke test for `pnpm generate-key` with the new --role flag.
// We exec the actual tsx script (not import it) so the test exercises the
// real CLI argv parsing + INSERT path. Cleans up the inserted row in after().

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { query, getOne, pool } from "../db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, "generate-key.ts");

function runScript(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      "node",
      ["--import=tsx", SCRIPT_PATH, ...args],
      {
        env: {
          ...process.env,
          DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://pact:pact@localhost:5443/pact",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const labelMerchant = `cli-merchant-${randomUUID().slice(0, 8)}`;
const labelAgent = `cli-agent-${randomUUID().slice(0, 8)}`;
const merchantPubkey = Keypair.fromSecretKey(nacl.sign.keyPair().secretKey)
  .publicKey.toBase58();

before(async () => {
  // no setup
});

after(async () => {
  await query("DELETE FROM api_keys WHERE label IN ($1, $2)", [
    labelMerchant,
    labelAgent,
  ]);
  await pool.end();
});

describe("generate-key --role", () => {
  it("inserts a role='merchant' row when --role merchant is passed", async () => {
    const r = await runScript([
      labelMerchant,
      "--role",
      "merchant",
      "--agent-pubkey",
      merchantPubkey,
    ]);
    assert.equal(r.code, 0, `script exited non-zero: ${r.stderr}`);
    // Reminder text in stdout when merchant role.
    assert.match(r.stdout, /REMINDER:/);
    assert.match(r.stdout, /POST \/api\/v1\/endpoint\/register/);

    const row = await getOne<{ role: string; agent_pubkey: string }>(
      "SELECT role, agent_pubkey FROM api_keys WHERE label = $1",
      [labelMerchant],
    );
    assert.equal(row?.role, "merchant");
    assert.equal(row?.agent_pubkey, merchantPubkey);
  });

  it("defaults to role='agent' when --role is omitted", async () => {
    const r = await runScript([labelAgent]);
    assert.equal(r.code, 0, `script exited non-zero: ${r.stderr}`);
    // No merchant reminder for agent role.
    assert.doesNotMatch(r.stdout, /REMINDER:/);
    const row = await getOne<{ role: string }>(
      "SELECT role FROM api_keys WHERE label = $1",
      [labelAgent],
    );
    assert.equal(row?.role, "agent");
  });

  it("exits non-zero on invalid --role", async () => {
    const r = await runScript([`invalid-${randomUUID()}`, "--role", "bogus"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--role/);
  });
});
