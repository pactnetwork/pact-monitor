/**
 * 03-fund-agents.ts — fund the 5 mock agents.
 *
 * For each agent:
 *   1. Airdrop SOL for rent + tx fees.
 *   2. Use the surfpool cheatcode `surfnet_setTokenAccount` to credit
 *      1000 USDC to the agent's ATA. This sidesteps the missing devnet
 *      USDC mint authority — surfpool will create the ATA if it doesn't
 *      exist and overwrite the amount.
 *   3. Run a real `Approve` SPL Token instruction so the SettlementAuthority
 *      PDA is the agent ATA's delegate with allowance == full balance. The
 *      on-chain settle_batch handler invokes `Token::Transfer` via the
 *      SettlementAuthority PDA seeds; without an Approve in place the
 *      transfer fails with `Owner does not match` / delegate insufficient.
 *
 * Also:
 *   - Pre-fund pool USDC vaults from the protocol authority (top_up_coverage_pool),
 *     so refunds in settle_batch have somewhere to come from (otherwise
 *     pool_vault.amount < refund_lamports → InsufficientFunds inside the SPL
 *     Token transfer CPI).
 *   - Pre-create the Treasury vault's USDC supply via cheatcode too.
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  buildApproveIx,
  buildTopUpCoveragePoolIx,
  getSettlementAuthorityPda,
  TOKEN_PROGRAM_ID,
  deriveAssociatedTokenAccount,
  slugBytes,
} from "@pact-network/protocol-v1-client";

import {
  AGENT_KEYPAIR,
  ENDPOINTS,
  NUM_AGENTS,
  PROGRAM_KEYPAIR,
  PROTOCOL_AUTHORITY_KEYPAIR,
  SMOKE_RPC_URL,
  USDC_DEVNET_MINT,
  USDC_PER_AGENT_LAMPORTS,
} from "./lib/paths";
import { readKeypair } from "./lib/keys";
import { loadState, patchState } from "./lib/state";

interface RpcCall { jsonrpc: "2.0"; id: number; method: string; params: unknown[]; }

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const body: RpcCall = { jsonrpc: "2.0", id: Date.now(), method, params };
  const res = await fetch(SMOKE_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`${method} failed: ${j.error.message}`);
  return j.result;
}

async function setTokenAccount(owner: PublicKey, amount: bigint, delegate?: PublicKey, delegatedAmount?: bigint) {
  // Surfpool 1.2 wire shape: 3 positional args (owner, mint, update). Numeric
  // fields are RAW u64s in JSON, NOT strings. (The skill docs are stale.)
  const update: Record<string, unknown> = { amount: Number(amount) };
  if (delegate) update.delegate = delegate.toBase58();
  if (delegatedAmount !== undefined) update.delegated_amount = Number(delegatedAmount);
  return rpc("surfnet_setTokenAccount", [owner.toBase58(), USDC_DEVNET_MINT, update]);
}

async function ensureFunded(conn: Connection, pubkey: PublicKey, sol = 5) {
  const bal = await conn.getBalance(pubkey, "confirmed");
  if (bal < sol * 1e9 / 2) {
    const sig = await conn.requestAirdrop(pubkey, sol * 1e9);
    await conn.confirmTransaction(sig, "confirmed");
  }
}

async function main() {
  const conn = new Connection(SMOKE_RPC_URL, "confirmed");
  const state = loadState();
  if (!state.programId) throw new Error("run 00-setup + 01-deploy + 02-init-protocol first");
  const programId = new PublicKey(state.programId);
  const auth = readKeypair(PROTOCOL_AUTHORITY_KEYPAIR);
  const usdcMint = new PublicKey(USDC_DEVNET_MINT);
  const [saPda] = getSettlementAuthorityPda(programId);

  // ----- Fund agent owners with SOL + USDC, then SPL-Token Approve the SA PDA -----
  const agentSnapshots: Array<{ index: number; pubkey: string; ata: string }> = [];
  for (let i = 0; i < NUM_AGENTS; i++) {
    const agent = readKeypair(AGENT_KEYPAIR(i));
    const ata = deriveAssociatedTokenAccount(agent.publicKey, usdcMint);
    console.log(`agent[${i}] ${agent.publicKey.toBase58()} ata=${ata.toBase58()}`);

    await ensureFunded(conn, agent.publicKey, 2);
    // Cheatcode mint + delegate to the SA PDA in one shot.
    await setTokenAccount(agent.publicKey, USDC_PER_AGENT_LAMPORTS, saPda, USDC_PER_AGENT_LAMPORTS);
    console.log(
      `  set ATA balance=${USDC_PER_AGENT_LAMPORTS} delegate=${saPda.toBase58()} delegatedAmount=${USDC_PER_AGENT_LAMPORTS}`,
    );

    // Belt & suspenders: also send a real Approve tx so the on-chain
    // delegated_amount field matches even if the cheatcode doesn't write it.
    try {
      const approveIx = buildApproveIx({
        agentAta: ata,
        settlementAuthorityPda: saPda,
        allowanceLamports: USDC_PER_AGENT_LAMPORTS,
        agentOwner: agent.publicKey,
      });
      const tx = new Transaction().add(approveIx);
      const sig = await sendAndConfirmTransaction(conn, tx, [agent], { commitment: "confirmed" });
      console.log(`  Approve sig: ${sig}`);
    } catch (e: unknown) {
      // If the ATA isn't a real SPL Token account yet (cheatcode behaviour
      // varies across surfpool versions), surface the warning but continue —
      // the cheatcode-set delegate is enough for settle_batch.
      console.warn(`  Approve tx failed (continuing): ${(e as Error).message}`);
    }

    agentSnapshots.push({ index: i, pubkey: agent.publicKey.toBase58(), ata: ata.toBase58() });
  }

  // ----- Pre-fund coverage pool vaults so refunds have funds to draw from -----
  // Use the protocol authority's USDC ATA as the source. Cheatcode-create it
  // first with enough USDC.
  const authAta = deriveAssociatedTokenAccount(auth.publicKey, usdcMint);
  const POOL_SEED_LAMPORTS = 50n * 1_000_000n; // 50 USDC per pool
  const totalSeed = POOL_SEED_LAMPORTS * BigInt(ENDPOINTS.length);
  await setTokenAccount(auth.publicKey, totalSeed);
  console.log(`\nseeded protocol authority ATA ${authAta.toBase58()} with ${totalSeed} lamports`);

  for (const ep of ENDPOINTS) {
    if (!state.endpoints) throw new Error("missing endpoints in state");
    const epState = state.endpoints.find((e) => e.slug === ep.slug);
    if (!epState) throw new Error(`endpoint ${ep.slug} not registered yet`);
    const ix = buildTopUpCoveragePoolIx({
      programId,
      authority: auth.publicKey,
      coveragePool: new PublicKey(epState.coveragePool),
      authorityAta: authAta,
      poolVault: new PublicKey(epState.poolVault),
      slug: slugBytes(ep.slug),
      amount: POOL_SEED_LAMPORTS,
    });
    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(conn, tx, [auth], { commitment: "confirmed" });
    console.log(`  top_up_coverage_pool(${ep.slug}, ${POOL_SEED_LAMPORTS}) sig=${sig}`);
  }

  patchState({ agents: agentSnapshots });

  console.log("\n== smoke-tier2/03-fund-agents OK ==");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
