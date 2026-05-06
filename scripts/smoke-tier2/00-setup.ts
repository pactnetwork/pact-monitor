/**
 * 00-setup.ts — generate keypairs for the tier-2 smoke harness.
 *
 * Creates (idempotent — re-running is safe):
 *   .smoke-keys/program.json                  — test program ID
 *   .smoke-keys/upgrade-authority.json        — upgrade authority for the program
 *   .smoke-keys/protocol-authority.json       — ProtocolConfig.authority + payer for init
 *   .smoke-keys/settlement-authority.json     — SettlementAuthority.signer (settler hot key)
 *   .smoke-keys/treasury-vault.json           — pre-allocated Treasury USDC vault keypair
 *   .smoke-keys/pool-vault-<slug>.json        — per-endpoint pool USDC vault keypair (5 of these)
 *   .smoke-keys/agent-{0..4}.json             — 5 mock agent owners
 *   .smoke-keys/test-usdc-mint.json           — generated, but UNUSED in the default flow
 *                                               (we use canonical USDC_DEVNET via surfpool fork)
 *
 * Writes initial state to .smoke-state/state.json.
 *
 * Note on USDC mint:
 *   The on-chain `initialize_protocol_config` rejects any mint that is not
 *   USDC_DEVNET (4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU) or USDC_MAINNET.
 *   To stay inside that constraint without modifying the program we run
 *   surfpool with `--network devnet` so it lazily forks the real devnet USDC
 *   mint, and we use the `surfnet_setTokenAccount` cheatcode to credit the
 *   five test agents directly (no mint authority needed). The
 *   `test-usdc-mint.json` is generated for completeness but not used in the
 *   default flow.
 */
import { Keypair } from "@solana/web3.js";
import {
  ENDPOINTS,
  KEYS_DIR,
  NUM_AGENTS,
  PROGRAM_KEYPAIR,
  PROTOCOL_AUTHORITY_KEYPAIR,
  SETTLEMENT_AUTHORITY_KEYPAIR,
  TEST_USDC_MINT_KEYPAIR,
  TREASURY_VAULT_KEYPAIR,
  UPGRADE_AUTHORITY_KEYPAIR,
  AGENT_KEYPAIR,
  POOL_VAULT_KEYPAIR,
  USDC_DEVNET_MINT,
  ensureDirs,
} from "./lib/paths";
import { loadOrCreate } from "./lib/keys";
import { patchState } from "./lib/state";

async function main() {
  ensureDirs();

  const program = loadOrCreate(PROGRAM_KEYPAIR);
  const upgradeAuth = loadOrCreate(UPGRADE_AUTHORITY_KEYPAIR);
  const protocolAuth = loadOrCreate(PROTOCOL_AUTHORITY_KEYPAIR);
  const settler = loadOrCreate(SETTLEMENT_AUTHORITY_KEYPAIR);
  const treasuryVault = loadOrCreate(TREASURY_VAULT_KEYPAIR);
  loadOrCreate(TEST_USDC_MINT_KEYPAIR); // generated but unused in default flow

  const agents = Array.from({ length: NUM_AGENTS }, (_, i) =>
    loadOrCreate(AGENT_KEYPAIR(i)),
  );
  for (const ep of ENDPOINTS) {
    loadOrCreate(POOL_VAULT_KEYPAIR(ep.slug));
  }

  patchState({
    programId: program.publicKey.toBase58(),
    protocolAuthority: protocolAuth.publicKey.toBase58(),
    settlementAuthoritySigner: settler.publicKey.toBase58(),
    testUsdcMint: USDC_DEVNET_MINT,
  });

  console.log("== smoke-tier2/00-setup OK ==");
  console.log(`  keys dir:                 ${KEYS_DIR}`);
  console.log(`  program ID (test):        ${program.publicKey.toBase58()}`);
  console.log(`  upgrade authority:        ${upgradeAuth.publicKey.toBase58()}`);
  console.log(`  protocol authority:       ${protocolAuth.publicKey.toBase58()}`);
  console.log(`  settlement signer:        ${settler.publicKey.toBase58()}`);
  console.log(`  treasury vault keypair:   ${treasuryVault.publicKey.toBase58()}`);
  console.log(`  USDC mint:                ${USDC_DEVNET_MINT} (devnet, forked)`);
  for (let i = 0; i < agents.length; i++) {
    console.log(`  agent[${i}]:                 ${agents[i].publicKey.toBase58()}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
