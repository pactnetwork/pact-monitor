// Pact Network — External Agent Demo (no Phantom mint authority required).
//
// Stand-alone happy path for an AI agent who clones the repo from outside the
// core team. Demonstrates the full lifecycle:
//   1. Load or generate a Solana keypair at $PACT_AGENT_KEYPAIR_PATH
//   2. Top up SOL via solana airdrop (best-effort; skipped if balance OK)
//   3. Drip TEST-USDC from the public faucet at api.pactnetwork.io
//   4. Read on-chain pool state for the target hostname
//   5. Provision an API key (admin token if available, else PACT_API_KEY)
//   6. Enable insurance with a USDC delegation
//   7. Run N successful monitor.fetch() calls
//   8. Run 1 forced timeout (latencyThresholdMs: 1ms) — classified as
//      `timeout`, IS claimable, exercises the on-chain claim flow
//   9. Run 1 forced 404 — classified as `client_error`, NOT claimable,
//      proves 4xx no longer files refunds
//  10. Print pool deltas, claim status, explorer links
//
// Usage:
//   pnpm tsx samples/demo/external-agent.ts [hostname] [success-calls]
//
// Env:
//   SOLANA_RPC_URL              default: https://api.devnet.solana.com
//   SOLANA_PROGRAM_ID           default: pinocchio program ID baked in SDK
//   PACT_BACKEND_URL            default: https://api.pactnetwork.io
//   PACT_AGENT_KEYPAIR_PATH     default: ~/.config/solana/pact-demo-agent.json
//   PACT_API_KEY                optional; reuses a previously-issued key.
//                               If unset, the demo calls
//                               POST /api/v1/keys/self-serve to obtain one
//                               (devnet-only, rate-limited 1/pubkey/hour).
//   ADMIN_TOKEN                 optional fallback for self-hosters running
//                               their own backend (POST /api/v1/admin/keys).

import "dotenv/config";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import { address, createSolanaRpc, getProgramDerivedAddress } from "@solana/kit";
import { pactMonitor } from "@pact-network/monitor";
import { PactInsurance, generated } from "@pact-network/insurance";

const {
  PACT_INSURANCE_PROGRAM_ADDRESS,
  PROTOCOL_CONFIG_SEED,
  COVERAGE_POOL_SEED,
  decodeProtocolConfig,
  decodeCoveragePool,
} = generated;

// -------- config --------

const HOSTNAME = process.argv[2] || "api.coingecko.com";
const SUCCESS_CALLS = parseInt(process.argv[3] || "3", 10);
const CALL_COST_USDC = 1; // $1 per call (whole USDC)
const ALLOWANCE_USDC = 5_000_000n; // 5 USDC delegated budget (lamports)
const FAUCET_AMOUNT_USDC = 10; // ask faucet for 10 USDC if balance is low

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.SOLANA_PROGRAM_ID || PACT_INSURANCE_PROGRAM_ADDRESS,
);
const BACKEND_URL = process.env.PACT_BACKEND_URL || "https://api.pactnetwork.io";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const KEYPAIR_PATH =
  process.env.PACT_AGENT_KEYPAIR_PATH ||
  path.join(os.homedir(), ".config/solana/pact-demo-agent.json");

const REAL_ENDPOINTS: Record<string, string> = {
  "api.coingecko.com": "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
  "api.dexscreener.com":
    "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112",
  "api.helius.xyz": "https://api.helius.xyz/v0/token-metadata?api-key=demo",
  "quote-api.jup.ag":
    "https://quote-api.jup.ag/v6/quote?inputMint=So11111111111111111111111111111111111111112&outputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&amount=1000000000",
  "solana-mainnet.quiknode.pro": "https://solana-mainnet.quiknode.pro/demo/",
};
const NOT_FOUND_ENDPOINT: Record<string, string> = {
  "api.coingecko.com": "https://api.coingecko.com/api/v3/does-not-exist",
  "api.dexscreener.com": "https://api.dexscreener.com/does/not/exist",
  "api.helius.xyz": "https://api.helius.xyz/v0/does-not-exist",
  "quote-api.jup.ag": "https://quote-api.jup.ag/v6/does-not-exist",
  "solana-mainnet.quiknode.pro": "https://solana-mainnet.quiknode.pro/does-not-exist/",
};

// -------- helpers --------

function log(step: string, msg: string) {
  console.log(`[${step}] ${msg}`);
}

function formatUsdc(raw: bigint | number): string {
  const n = typeof raw === "bigint" ? Number(raw) : raw;
  return `${(n / 1e6).toFixed(4)} USDC`;
}

function loadOrCreateKeypair(p: string): Keypair {
  if (fs.existsSync(p)) {
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))),
    );
  }
  const fresh = Keypair.generate();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(Array.from(fresh.secretKey)));
  log("init", `generated fresh keypair at ${p}`);
  return fresh;
}

async function ensureSol(connection: Connection, agent: Keypair, minLamports: number) {
  const bal = await connection.getBalance(agent.publicKey);
  if (bal >= minLamports) {
    log("sol", `balance OK: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    return;
  }
  log("sol", `requesting devnet airdrop (${minLamports / LAMPORTS_PER_SOL} SOL)`);
  try {
    const sig = await connection.requestAirdrop(agent.publicKey, minLamports);
    await connection.confirmTransaction(sig, "confirmed");
    log("sol", `airdrop OK: ${sig.slice(0, 16)}...`);
  } catch (err) {
    log(
      "sol",
      `airdrop failed (rate-limited?): ${(err as Error).message}. ` +
        `Fund the wallet manually with: solana airdrop 1 ${agent.publicKey.toBase58()} --url devnet`,
    );
  }
}

async function dripUsdc(recipient: string, amount: number): Promise<{ ata: string }> {
  const res = await globalThis.fetch(`${BACKEND_URL}/api/v1/faucet/drip`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "pact-monitor-sdk/0.1.0",
    },
    body: JSON.stringify({ recipient, amount }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`faucet drip ${res.status}: ${txt}`);
  }
  const body = (await res.json()) as { signature: string; ata: string };
  log("faucet", `drip OK: ${body.signature.slice(0, 16)}... -> ATA ${body.ata.slice(0, 8)}...`);
  return { ata: body.ata };
}

async function ensureApiKey(agent: Keypair): Promise<string> {
  // Order of preference:
  //   1. PACT_API_KEY env var — for users who already have a key from a prior
  //      run (avoids exhausting the per-pubkey rate limit on every demo run).
  //   2. Public self-serve route — devnet-only, anonymous, rate-limited.
  //      Two-step protocol (PR #50 codex fix):
  //        a. POST /self-serve/challenge → server returns a nonce + canonical message
  //        b. agent signs the message with its keypair
  //        c. POST /self-serve with {agent_pubkey, nonce, signature}
  //      The signature proves the requester owns the keypair backing the
  //      pubkey — without this proof, anyone could mint keys for any wallet.
  //   3. ADMIN_TOKEN admin route — for self-hosters who run their own backend.
  const agentPubkey = agent.publicKey.toBase58();
  const existing = process.env.PACT_API_KEY;
  if (existing && existing !== "pact_your_key_here") {
    log("auth", `using pre-provisioned PACT_API_KEY ${existing.slice(0, 16)}...`);
    return existing;
  }

  // Step 2a: ask the backend for a fresh challenge nonce.
  const challRes = await globalThis.fetch(`${BACKEND_URL}/api/v1/keys/self-serve/challenge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "pact-monitor-sdk/0.1.0",
    },
    body: JSON.stringify({ agent_pubkey: agentPubkey }),
  });
  if (challRes.ok) {
    const ch = (await challRes.json()) as { nonce: string; message: string; expiresAt: string };

    // Step 2b: sign the canonical message with the agent's keypair.
    // tweetnacl is used directly to avoid pulling another sig library; the
    // backend verifies via the same nacl.sign.detached.verify.
    const { default: nacl } = await import("tweetnacl");
    const sigBytes = nacl.sign.detached(
      new TextEncoder().encode(ch.message),
      agent.secretKey,
    );
    const signature = Buffer.from(sigBytes).toString("base64");

    // Step 2c: redeem the signed challenge for an API key.
    const issueRes = await globalThis.fetch(`${BACKEND_URL}/api/v1/keys/self-serve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "pact-monitor-sdk/0.1.0",
      },
      body: JSON.stringify({ agent_pubkey: agentPubkey, nonce: ch.nonce, signature }),
    });
    if (issueRes.ok) {
      const body = (await issueRes.json()) as { apiKey: string };
      log("auth", `self-serve api key ${body.apiKey.slice(0, 16)}... bound to ${agentPubkey.slice(0, 8)}...`);
      log("auth", `set PACT_API_KEY=${body.apiKey} to reuse this key on the next run (avoids per-pubkey rate limit)`);
      return body.apiKey;
    }
    const status = issueRes.status;
    const body = await issueRes.text();
    if (status === 429) {
      throw new Error(
        `self-serve api key rate-limited: ${body}\n` +
          `Set PACT_API_KEY to a previously-issued key, or wait the indicated period.`,
      );
    }
    // Fall through to ADMIN_TOKEN below if signature/nonce dance failed
    // unexpectedly; report the issuance error for diagnostics.
    log("auth", `self-serve issuance failed (${status}): ${body}; falling back to ADMIN_TOKEN if set`);
  }
  const selfServeStatus = challRes.status;
  const selfServeBody = await challRes.text().catch(() => "");

  // 410 = self-serve disabled (mainnet); 404 = backend doesn't have the route
  // (running an older deploy). Fall through to admin path. 429 = rate-limited
  // for this pubkey — the user must wait or pass PACT_API_KEY.
  if (selfServeStatus === 429) {
    throw new Error(
      `self-serve api key rate-limited: ${selfServeBody}\n` +
        `Set PACT_API_KEY to a previously-issued key, or wait the indicated period.`,
    );
  }

  if (!ADMIN_TOKEN) {
    if (selfServeStatus === 410) {
      throw new Error(
        `Self-serve API keys are disabled on ${BACKEND_URL} (likely mainnet). ` +
          `Set PACT_API_KEY to an admin-issued key, or point PACT_BACKEND_URL at a devnet deployment.`,
      );
    }
    throw new Error(
      `Could not obtain an API key.\n` +
        `  Self-serve: ${selfServeStatus} ${selfServeBody}\n` +
        `Set PACT_API_KEY directly or set ADMIN_TOKEN to fall back to /api/v1/admin/keys.`,
    );
  }

  // ADMIN_TOKEN fallback for self-hosters.
  const label = `external-agent-demo-${Date.now()}`;
  const res = await globalThis.fetch(`${BACKEND_URL}/api/v1/admin/keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "User-Agent": "pact-monitor-sdk/0.1.0",
    },
    body: JSON.stringify({ label, agent_pubkey: agentPubkey }),
  });
  if (!res.ok) {
    throw new Error(`admin /keys ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { apiKey: string };
  log("auth", `admin-provisioned api key ${body.apiKey.slice(0, 16)}... bound to ${agentPubkey.slice(0, 8)}...`);
  return body.apiKey;
}

async function fetchAccountBytes(
  rpc: ReturnType<typeof createSolanaRpc>,
  addr: string,
): Promise<Uint8Array | null> {
  const result = await (rpc as any)
    .getAccountInfo(addr, { encoding: "base64" })
    .send();
  if (!result.value) return null;
  return new Uint8Array(Buffer.from(result.value.data[0] as string, "base64"));
}

// -------- main --------

async function main() {
  console.log("=== Pact Network — External Agent Demo ===");
  log("cfg", `Hostname:       ${HOSTNAME}`);
  log("cfg", `Success calls:  ${SUCCESS_CALLS}`);
  log("cfg", `Per-call cost:  ${formatUsdc(CALL_COST_USDC * 1e6)}`);
  log("cfg", `RPC:            ${RPC_URL}`);
  log("cfg", `Backend:        ${BACKEND_URL}`);
  console.log("");

  // -------- agent setup --------
  const agent = loadOrCreateKeypair(KEYPAIR_PATH);
  log("agent", `pubkey: ${agent.publicKey.toBase58()}`);

  const connection = new Connection(RPC_URL, "confirmed");
  const rpc = createSolanaRpc(RPC_URL);
  await ensureSol(connection, agent, 0.05 * LAMPORTS_PER_SOL);

  // -------- on-chain pool sanity --------
  // Derive PDAs against the configured PROGRAM_ID so SOLANA_PROGRAM_ID overrides
  // (e.g. the Pinocchio devnet deploy) resolve to the same accounts the SDK
  // below will touch. The Codama-generated find*Pda helpers hardcode the
  // baked-in default and would silently report "no pool exists" against any
  // non-default program.
  const programAddress = address(PROGRAM_ID.toBase58());
  const [protocolPda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [PROTOCOL_CONFIG_SEED],
  });
  const [poolPda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [COVERAGE_POOL_SEED, new TextEncoder().encode(HOSTNAME)],
  });

  const configBytes = await fetchAccountBytes(rpc, protocolPda as string);
  if (!configBytes) {
    console.error(`[FAIL] protocol config not found at ${protocolPda}. Wrong network?`);
    process.exit(1);
  }
  const config = decodeProtocolConfig(configBytes);
  const usdcMint = new PublicKey(config.usdcMint as string);

  const poolBytesBefore = await fetchAccountBytes(rpc, poolPda as string);
  if (!poolBytesBefore) {
    console.error(
      `[FAIL] no pool exists for hostname="${HOSTNAME}". ` +
        `Try one of: api.coingecko.com, api.dexscreener.com, api.helius.xyz, ` +
        `quote-api.jup.ag, solana-mainnet.quiknode.pro`,
    );
    process.exit(1);
  }
  const poolBefore = decodeCoveragePool(poolBytesBefore);
  log(
    "pool.before",
    `total_available=${formatUsdc(poolBefore.totalAvailable)} ` +
      `claims_paid=${formatUsdc(poolBefore.totalClaimsPaid)} ` +
      `rate=${poolBefore.insuranceRateBps}bps ` +
      `active=${poolBefore.activePolicies}`,
  );

  // -------- USDC: check balance first, drip only if low --------
  const { getAssociatedTokenAddressSync: ataSync } = await import("@solana/spl-token");
  const agentAta = ataSync(usdcMint, agent.publicKey);
  const minRequiredUsdcLamports = ALLOWANCE_USDC + BigInt((SUCCESS_CALLS + 2) * CALL_COST_USDC * 1_000_000);
  let agentUsdcBalance = 0n;
  try {
    const ta = await getAccount(connection, agentAta);
    agentUsdcBalance = ta.amount;
  } catch {
    // ATA doesn't exist yet — drip will create it
  }
  if (agentUsdcBalance >= minRequiredUsdcLamports) {
    log("usdc", `balance OK: ${formatUsdc(agentUsdcBalance)} (skipping faucet)`);
  } else {
    log(
      "usdc",
      `balance=${formatUsdc(agentUsdcBalance)} < required ${formatUsdc(minRequiredUsdcLamports)}; requesting drip`,
    );
    try {
      await dripUsdc(agent.publicKey.toBase58(), FAUCET_AMOUNT_USDC);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("429")) {
        log(
          "usdc",
          `faucet rate-limited and current balance ${formatUsdc(agentUsdcBalance)} is below ${formatUsdc(minRequiredUsdcLamports)}.`,
        );
        log(
          "usdc",
          `Wait the indicated minutes and re-run, or set ALLOWANCE_USDC lower in the script.`,
        );
        throw err;
      }
      throw err;
    }
  }

  // -------- enable insurance (or top up if already enabled) --------
  const insurance = new PactInsurance(
    { rpcUrl: RPC_URL, programId: PROGRAM_ID.toBase58() },
    agent,
  );

  const existingPolicy = await insurance.getPolicy(HOSTNAME);
  if (existingPolicy && existingPolicy.active) {
    log(
      "enable",
      `policy already exists for this (agent, hostname) — agent_id=${existingPolicy.agentId} expires_at=${existingPolicy.expiresAt}`,
    );
    log("enable", `topping up delegation to ${formatUsdc(ALLOWANCE_USDC)}`);
    const topUpSig = await insurance.topUpDelegation({
      providerHostname: HOSTNAME,
      newTotalAllowanceUsdc: ALLOWANCE_USDC,
    });
    log("enable", `topUp tx: ${topUpSig.slice(0, 16)}...`);
    log("enable", `https://explorer.solana.com/tx/${topUpSig}?cluster=devnet`);
  } else {
    const enableSig = await insurance.enableInsurance({
      providerHostname: HOSTNAME,
      allowanceUsdc: ALLOWANCE_USDC,
      expiresAt: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400),
      agentId: `ext-${Date.now().toString(36)}`,
    });
    log("enable", `policy active (tx ${enableSig.slice(0, 16)}...)`);
    log("enable", `https://explorer.solana.com/tx/${enableSig}?cluster=devnet`);
  }

  const policy = await insurance.getPolicy(HOSTNAME);
  if (policy) {
    log(
      "policy",
      `agent_id=${policy.agentId} delegated=${formatUsdc(policy.delegatedAmount)} ` +
        `expires_at=${policy.expiresAt}`,
    );
  }
  console.log("");

  // -------- API key for SDK --------
  const apiKey = await ensureApiKey(agent);

  // -------- run calls through monitor --------
  const monitor = pactMonitor({
    apiKey,
    backendUrl: BACKEND_URL,
    syncEnabled: true,
    syncIntervalMs: 3_000,
    latencyThresholdMs: 5_000,
    agentPubkey: agent.publicKey.toBase58(),
  });

  const realUrl = REAL_ENDPOINTS[HOSTNAME];
  const notFoundUrl = NOT_FOUND_ENDPOINT[HOSTNAME];

  console.log("=== Success calls ===");
  for (let i = 0; i < SUCCESS_CALLS; i++) {
    const start = Date.now();
    try {
      const res = await monitor.fetch(realUrl, {}, { usdcAmount: CALL_COST_USDC });
      log(
        "call",
        `#${i + 1} ${res.status} ${Date.now() - start}ms — billed ${formatUsdc(CALL_COST_USDC * 1e6)}`,
      );
    } catch (err) {
      log("call", `#${i + 1} UNEXPECTED ERROR: ${(err as Error).message}`);
    }
  }
  console.log("");

  console.log("=== Forced timeout call (claimable, latency budget = 1ms) ===");
  // Sub-monitor with an absurdly tight latency budget. A normal HTTPS round-trip
  // exceeds 1ms, so the call is classified as `timeout`, which IS claimable.
  // Provider's hostname is the same, so the claim files against the same pool.
  const tightMonitor = pactMonitor({
    apiKey,
    backendUrl: BACKEND_URL,
    syncEnabled: true,
    syncIntervalMs: 3_000,
    latencyThresholdMs: 1, // forces `timeout` classification on any real call
    agentPubkey: agent.publicKey.toBase58(),
  });
  const tStart = Date.now();
  try {
    const res = await tightMonitor.fetch(realUrl, {}, { usdcAmount: CALL_COST_USDC });
    log(
      "call",
      `TIMEOUT-FORCED ${res.status} ${Date.now() - tStart}ms (will classify as 'timeout' — claimable)`,
    );
  } catch (err) {
    log("call", `TIMEOUT-FORCED network error: ${(err as Error).message}`);
  }
  console.log("");

  console.log("=== Forced 404 call (NOT claimable — agent's URL bug) ===");
  const fStart = Date.now();
  try {
    const res = await monitor.fetch(notFoundUrl, {}, { usdcAmount: CALL_COST_USDC });
    log(
      "call",
      `404-FORCED ${res.status} ${Date.now() - fStart}ms (will classify as 'client_error' — NO claim)`,
    );
  } catch (err) {
    log("call", `404-FORCED network error: ${(err as Error).message}`);
  }
  console.log("");

  // -------- wait for sync + on-chain settle --------
  log("sync", "waiting 8s for backend sync + on-chain settle...");
  await new Promise((r) => setTimeout(r, 8_000));
  monitor.shutdown();
  tightMonitor.shutdown();
  await new Promise((r) => setTimeout(r, 2_000));

  // -------- verify --------
  let agentUsdcAfter = 0n;
  try {
    const taAfter = await getAccount(connection, agentAta);
    agentUsdcAfter = taAfter.amount;
  } catch (err) {
    log("verify", `failed reading agent ATA: ${(err as Error).message}`);
  }

  const poolBytesAfter = await fetchAccountBytes(rpc, poolPda as string);
  if (!poolBytesAfter) {
    console.error("[FAIL] coverage pool not found after run");
    process.exit(1);
  }
  const poolAfter = decodeCoveragePool(poolBytesAfter);
  const claimsPaidDelta = poolAfter.totalClaimsPaid - poolBefore.totalClaimsPaid;

  console.log("");
  console.log("=== Results ===");
  log("agent", `USDC balance: ${formatUsdc(agentUsdcAfter)}`);
  log(
    "pool.after",
    `total_available=${formatUsdc(poolAfter.totalAvailable)} ` +
      `claims_paid=${formatUsdc(poolAfter.totalClaimsPaid)} ` +
      `rate=${poolAfter.insuranceRateBps}bps ` +
      `active=${poolAfter.activePolicies}`,
  );
  log("delta", `pool claims_paid: +${formatUsdc(claimsPaidDelta)}`);
  log(
    "verdict",
    claimsPaidDelta > 0n
      ? "REFUND LANDED ON-CHAIN — the timeout call triggered a real on-chain claim."
      : "NO REFUND OBSERVED — check that the timeout call was synced and reached the claim handler.",
  );
  console.log("");
  console.log(`Agent wallet: https://explorer.solana.com/address/${agent.publicKey.toBase58()}?cluster=devnet`);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
