/**
 * premium-settler.test.ts
 *
 * Tests for runPremiumSettler using a real Postgres instance and a lightweight
 * node:http mock RPC server. mock.module() is intentionally avoided: it does
 * not compose with tsx's ESM loader in Node.js 24. The mock HTTP server lets
 * us control every Solana RPC response without patching the module graph.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import Fastify from "fastify";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { initDb, query, pool } from "../db.js";
import { __resetOracleKeypairCacheForTests } from "../utils/solana.js";

// ---------------------------------------------------------------------------
// Test-wide constants — valid Solana program addresses used as dummy pubkeys.
// ---------------------------------------------------------------------------
const MOCK_HOSTNAME   = `settler-test-${randomUUID().slice(0, 8)}.example.com`;
const MOCK_AGENT_PK   = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"; // Token-2022
const MOCK_AGENT_ATA  = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"; // Token program
const MOCK_POOL_PDA   = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bJ"; // ATA program
const MOCK_POLICY_PDA = "So11111111111111111111111111111111111111112";   // wSOL mint
const MOCK_SIG        = "4NMwxzmYj2uvHuq8xoqhY8RXg63KSVJM1DXkpbmkUY7YQWuoyagLVALikXo7UGWH4eZ6q7m5PAp3Q2XEUP82Tgy";

// ---------------------------------------------------------------------------
// Helpers: build binary-encoded Solana account bytes.
//
// Each layout mirrors the bytemuck repr(C) in the Pinocchio program.
// Only the fields consumed by runPremiumSettler are written; everything else
// is left as zero (reads as 0 / system-program for address fields).
// ---------------------------------------------------------------------------

// ProtocolConfig: disc(1) + pad(7) + authority(32) + oracle(32) + treasury(32) + usdcMint(32) + …
// treasury @ 72, usdcMint @ 104.  All zero → system-program address, which is valid.
function buildProtocolConfigBytes(): Buffer {
  return Buffer.alloc(256, 0); // discriminator = 0 at offset 0 ✓
}

// CoveragePool: disc(1) + pad(7) + authority(32) + usdcMint(32) + vault(32)
//              + providerHostname(64) + 9×u64(72) + u32(4) + 2×u16(4)
//              + providerHostnameLen(1) + bump(1) + padTail(6) + reserved(64)
// vault @ 72, hostname @ 104, hostnameLen @ 248.
function buildCoveragePoolBytes(hostname: string): Buffer {
  const buf = Buffer.alloc(320, 0);
  buf[0] = 1; // COVERAGE_POOL_DISCRIMINATOR
  const hostBytes = Buffer.from(hostname, "utf8");
  hostBytes.copy(buf, 104);
  buf[248] = hostBytes.length;
  return buf;
}

// Policy: disc(1) + pad(7) + agent(32) + pool(32) + agentTokenAccount(32)
//         + agentId(64) + 3×u64(24) + 2×i64(16) + agentIdLen(1)
//         + active(1) + bump(1) + padTail(5) + referrer(32)
//         + referrerShareBps(2) + referrerPresent(1) + …
// agent @ 8, agentTokenAccount @ 72, active @ 209, referrerPresent @ 250.
function buildPolicyBytes(agent: string, agentAta: string, active: 0 | 1): Buffer {
  const buf = Buffer.alloc(320, 0);
  buf[0] = 3; // POLICY_DISCRIMINATOR
  buf.set(bs58.decode(agent), 8);
  buf.set(bs58.decode(agentAta), 72);
  buf[209] = active;
  // referrerPresent at 250 = 0 (already)
  return buf;
}

// ---------------------------------------------------------------------------
// Mock JSON-RPC server.
// Handlers are stored per-method in a queue; each call pops and invokes the
// next handler for that method, enabling different responses on repeat calls
// (e.g., two getProgramAccounts calls: one for pools, one for policies).
// ---------------------------------------------------------------------------
interface RpcServerHandle {
  url: string;
  /** Queue a one-shot response handler for a given JSON-RPC method. */
  on: (method: string, fn: () => unknown) => void;
  close: () => Promise<void>;
}

async function startMockRpc(): Promise<RpcServerHandle> {
  const queues = new Map<string, Array<() => unknown>>();

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: unknown; method: string };
      const queue = queues.get(method) ?? [];
      const handler = queue.shift();
      queues.set(method, queue);

      const result = handler ? handler() : null;
      res.setHeader("Content-Type", "application/json");
      if (result instanceof Error) {
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32003, message: result.message } }),
        );
      } else {
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  return {
    url: `http://127.0.0.1:${port}`,
    on(method, fn) {
      const q = queues.get(method) ?? [];
      q.push(fn);
      queues.set(method, q);
    },
    close: () => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())),
  };
}

// ---------------------------------------------------------------------------
// Convenience: pre-fill the common happy-path RPC response sequence.
// ---------------------------------------------------------------------------
function queueHappyPath(
  rpc: RpcServerHandle,
  opts: {
    pools?: Array<{ pubkey: string; dataB64: string }>;
    policies?: Array<{ pubkey: string; dataB64: string }>;
    sendTxSig?: string | Error;
  } = {},
) {
  const configB64 = buildProtocolConfigBytes().toString("base64");
  rpc.on("getAccountInfo", () => ({
    context: { slot: 1 },
    value: {
      data: [configB64, "base64"],
      executable: false,
      lamports: 1_000_000,
      owner: "11111111111111111111111111111111",
      rentEpoch: 0,
      space: 256,
    },
  }));

  // First getProgramAccounts = pool list
  const pools = opts.pools ?? [];
  rpc.on("getProgramAccounts", () => pools.map((p) => ({
    pubkey: p.pubkey,
    account: { data: [p.dataB64, "base64"], executable: false, lamports: 1_000_000, owner: "11111111111111111111111111111111", rentEpoch: 0, space: 320 },
  })));

  // Second getProgramAccounts = policy list for the pool
  const policies = opts.policies ?? [];
  rpc.on("getProgramAccounts", () => policies.map((p) => ({
    pubkey: p.pubkey,
    account: { data: [p.dataB64, "base64"], executable: false, lamports: 1_000_000, owner: "11111111111111111111111111111111", rentEpoch: 0, space: 320 },
  })));

  if (opts.sendTxSig !== undefined) {
    const sendTxSig = opts.sendTxSig;
    rpc.on("getLatestBlockhash", () => ({
      context: { slot: 1 },
      value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 999_999 },
    }));
    rpc.on("sendTransaction", () => {
      if (sendTxSig instanceof Error) return sendTxSig;
      return sendTxSig;
    });
    if (!(sendTxSig instanceof Error)) {
      rpc.on("getSignatureStatuses", () => ({
        context: { slot: 1 },
        value: [{ slot: 1, confirmations: 10, err: null, confirmationStatus: "confirmed", status: { Ok: null } }],
      }));
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("runPremiumSettler", () => {
  let oracleKp: Keypair;
  let runPremiumSettler: (app: unknown) => Promise<void>;
  let app: ReturnType<typeof Fastify>;
  const savedEnv: Record<string, string | undefined> = {};

  before(async () => {
    await initDb();
    oracleKp = Keypair.generate();

    const mod = await import("../crank/premium-settler.js");
    runPremiumSettler = (mod as { runPremiumSettler: typeof runPremiumSettler }).runPremiumSettler;
    app = Fastify({ logger: false });

    // Save env vars we'll override so other tests aren't affected.
    for (const k of ["SOLANA_RPC_URL", "SOLANA_PROGRAM_ID", "USDC_MINT", "ORACLE_KEYPAIR_BASE58"]) {
      savedEnv[k] = process.env[k];
    }
  });

  after(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetOracleKeypairCacheForTests();
    await app.close();
    await pool.end();
  });

  /** Set env to point at a mock RPC server with valid oracle keypair. */
  function configureEnv(rpcUrl: string) {
    __resetOracleKeypairCacheForTests();
    process.env.SOLANA_RPC_URL = rpcUrl;
    process.env.SOLANA_PROGRAM_ID = "11111111111111111111111111111111";
    process.env.USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    process.env.ORACLE_KEYPAIR_BASE58 = bs58.encode(oracleKp.secretKey);
  }

  it("throws (config guard) when SOLANA_PROGRAM_ID is not set", async () => {
    const saved = process.env.SOLANA_PROGRAM_ID;
    delete process.env.SOLANA_PROGRAM_ID;
    try {
      await assert.rejects(
        () => runPremiumSettler(app),
        /SOLANA_PROGRAM_ID/,
        "function must reject when SOLANA_PROGRAM_ID is missing",
      );
    } finally {
      if (saved !== undefined) process.env.SOLANA_PROGRAM_ID = saved;
    }
  });

  it("returns early and writes nothing when getAccountInfo returns null (config account missing)", async () => {
    const rpc = await startMockRpc();
    rpc.on("getAccountInfo", () => ({ context: { slot: 1 }, value: null }));
    configureEnv(rpc.url);
    try {
      await runPremiumSettler(app);

      const { rows } = await query<{ n: number }>(
        "SELECT count(*)::int AS n FROM policy_settlements WHERE policy_pda = $1",
        [MOCK_POLICY_PDA],
      );
      assert.equal(rows[0].n, 0, "no settlement row must be created on early return");
    } finally {
      await rpc.close();
    }
  });

  it("no-ops when getProgramAccounts returns an empty pool list", async () => {
    const rpc = await startMockRpc();
    queueHappyPath(rpc, { pools: [] });
    configureEnv(rpc.url);
    try {
      await runPremiumSettler(app);
      // No assertion needed beyond "does not throw" — empty pools = no writes.
    } finally {
      await rpc.close();
    }
  });

  it("skips inactive policy (active=0) without a DB write", async () => {
    const rpc = await startMockRpc();
    const poolBytes = buildCoveragePoolBytes(MOCK_HOSTNAME).toString("base64");
    const policyBytes = buildPolicyBytes(MOCK_AGENT_PK, MOCK_AGENT_ATA, 0).toString("base64"); // active = 0
    queueHappyPath(rpc, {
      pools: [{ pubkey: MOCK_POOL_PDA, dataB64: poolBytes }],
      policies: [{ pubkey: MOCK_POLICY_PDA, dataB64: policyBytes }],
    });
    configureEnv(rpc.url);
    try {
      await runPremiumSettler(app);

      const { rows } = await query<{ n: number }>(
        "SELECT count(*)::int AS n FROM policy_settlements WHERE policy_pda = $1",
        [MOCK_POLICY_PDA],
      );
      assert.equal(rows[0].n, 0, "inactive policy must not create a settlement row");
    } finally {
      await rpc.close();
    }
  });

  it("upserts watermark but skips sendTx when call value sums to zero (no matching call_records)", async () => {
    const rpc = await startMockRpc();
    const poolBytes = buildCoveragePoolBytes(MOCK_HOSTNAME).toString("base64");
    const policyBytes = buildPolicyBytes(MOCK_AGENT_PK, MOCK_AGENT_ATA, 1).toString("base64");
    queueHappyPath(rpc, {
      pools: [{ pubkey: MOCK_POOL_PDA, dataB64: poolBytes }],
      policies: [{ pubkey: MOCK_POLICY_PDA, dataB64: policyBytes }],
      // no sendTxSig → no blockhash/sendTx/statusCheck handlers queued
    });
    configureEnv(rpc.url);
    // Ensure no provider/call_records for this agent+hostname exist in the window.
    try {
      await runPremiumSettler(app);

      const { rows } = await query<{ policy_pda: string }>(
        "SELECT policy_pda FROM policy_settlements WHERE policy_pda = $1",
        [MOCK_POLICY_PDA],
      );
      assert.equal(rows.length, 1, "watermark row must be created even when call value is 0");
    } finally {
      await query("DELETE FROM policy_settlements WHERE policy_pda = $1", [MOCK_POLICY_PDA]);
      await rpc.close();
    }
  });

  it("calls sendTx and upserts watermark when call value exceeds zero", async () => {
    const rpc = await startMockRpc();
    const poolBytes = buildCoveragePoolBytes(MOCK_HOSTNAME).toString("base64");
    const policyBytes = buildPolicyBytes(MOCK_AGENT_PK, MOCK_AGENT_ATA, 1).toString("base64");
    queueHappyPath(rpc, {
      pools: [{ pubkey: MOCK_POOL_PDA, dataB64: poolBytes }],
      policies: [{ pubkey: MOCK_POLICY_PDA, dataB64: policyBytes }],
      sendTxSig: MOCK_SIG,
    });
    configureEnv(rpc.url);

    // Seed: provider matching MOCK_HOSTNAME + a paid call record in the 15-min window.
    const { rows: [prov] } = await query<{ id: string }>(
      "INSERT INTO providers (name, base_url) VALUES ($1, $2) ON CONFLICT (base_url) DO UPDATE SET name = EXCLUDED.name RETURNING id",
      [MOCK_HOSTNAME, MOCK_HOSTNAME],
    );
    try {
      await query(
        `INSERT INTO call_records
           (provider_id, endpoint, timestamp, status_code, latency_ms, classification, agent_pubkey, payment_amount)
         VALUES ($1, '/v1', NOW(), 200, 50, 'success', $2, 1000000)`,
        [prov.id, MOCK_AGENT_PK],
      );

      await runPremiumSettler(app);

      const { rows } = await query<{ policy_pda: string }>(
        "SELECT policy_pda FROM policy_settlements WHERE policy_pda = $1",
        [MOCK_POLICY_PDA],
      );
      assert.equal(rows.length, 1, "watermark must be upserted after successful settlement");
    } finally {
      await query("DELETE FROM policy_settlements WHERE policy_pda = $1", [MOCK_POLICY_PDA]);
      await query("DELETE FROM call_records WHERE provider_id = $1", [prov.id]);
      await query("DELETE FROM providers WHERE id = $1", [prov.id]);
      await rpc.close();
    }
  });

  it("does not write watermark and does not throw when sendTx rejects", async () => {
    const rpc = await startMockRpc();
    const poolBytes = buildCoveragePoolBytes(MOCK_HOSTNAME).toString("base64");
    const policyBytes = buildPolicyBytes(MOCK_AGENT_PK, MOCK_AGENT_ATA, 1).toString("base64");
    queueHappyPath(rpc, {
      pools: [{ pubkey: MOCK_POOL_PDA, dataB64: poolBytes }],
      policies: [{ pubkey: MOCK_POLICY_PDA, dataB64: policyBytes }],
      sendTxSig: new Error("simulated RPC failure"),
    });
    configureEnv(rpc.url);

    const { rows: [prov] } = await query<{ id: string }>(
      "INSERT INTO providers (name, base_url) VALUES ($1, $2) ON CONFLICT (base_url) DO UPDATE SET name = EXCLUDED.name RETURNING id",
      [MOCK_HOSTNAME, MOCK_HOSTNAME],
    );
    try {
      await query(
        `INSERT INTO call_records
           (provider_id, endpoint, timestamp, status_code, latency_ms, classification, agent_pubkey, payment_amount)
         VALUES ($1, '/v1/err', NOW(), 200, 50, 'success', $2, 9000)`,
        [prov.id, MOCK_AGENT_PK],
      );

      await assert.doesNotReject(
        () => runPremiumSettler(app),
        "function must absorb per-policy RPC errors and not propagate",
      );

      const { rows } = await query<{ n: number }>(
        "SELECT count(*)::int AS n FROM policy_settlements WHERE policy_pda = $1",
        [MOCK_POLICY_PDA],
      );
      assert.equal(rows[0].n, 0, "watermark must not be written when sendTx fails");
    } finally {
      await query("DELETE FROM call_records WHERE provider_id = $1 AND endpoint = '/v1/err'", [prov.id]);
      await query("DELETE FROM providers WHERE id = $1", [prov.id]);
      await rpc.close();
    }
  });

  it("skips malformed pool account data and completes without error", async () => {
    const rpc = await startMockRpc();
    // Send garbage bytes for the pool — decodeCoveragePool will throw and the
    // pool is skipped; the function must continue rather than propagate.
    const garbageB64 = Buffer.alloc(10, 0xff).toString("base64");
    queueHappyPath(rpc, {
      pools: [{ pubkey: MOCK_POOL_PDA, dataB64: garbageB64 }],
      // no policies queued (never reached for a bad pool)
    });
    configureEnv(rpc.url);
    try {
      await assert.doesNotReject(
        () => runPremiumSettler(app),
        "corrupt pool bytes must be skipped, not propagated",
      );
    } finally {
      await rpc.close();
    }
  });
});
