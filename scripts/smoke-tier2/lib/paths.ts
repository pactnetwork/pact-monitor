/**
 * Shared path constants for the tier-2 smoke harness.
 *
 * Everything under `.smoke-keys/`, `.smoke-state/`, `.logs/` is gitignored
 * (see worktree `.gitignore`) and must NEVER be committed.
 */
import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const SMOKE_DIR = resolve(__dirname, "..");
export const REPO_ROOT = resolve(SMOKE_DIR, "..", "..");
export const KEYS_DIR = resolve(SMOKE_DIR, ".smoke-keys");
export const STATE_DIR = resolve(SMOKE_DIR, ".smoke-state");
export const LOGS_DIR = resolve(SMOKE_DIR, ".logs");

export function ensureDirs(): void {
  for (const d of [KEYS_DIR, STATE_DIR, LOGS_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

// Keypair file paths
export const PROGRAM_KEYPAIR = resolve(KEYS_DIR, "program.json");
export const UPGRADE_AUTHORITY_KEYPAIR = resolve(KEYS_DIR, "upgrade-authority.json");
export const PROTOCOL_AUTHORITY_KEYPAIR = resolve(KEYS_DIR, "protocol-authority.json");
export const SETTLEMENT_AUTHORITY_KEYPAIR = resolve(KEYS_DIR, "settlement-authority.json");
export const TREASURY_VAULT_KEYPAIR = resolve(KEYS_DIR, "treasury-vault.json");
export const POOL_VAULT_KEYPAIR = (slug: string) =>
  resolve(KEYS_DIR, `pool-vault-${slug}.json`);
export const AGENT_KEYPAIR = (i: number) =>
  resolve(KEYS_DIR, `agent-${i}.json`);
export const TEST_USDC_MINT_KEYPAIR = resolve(KEYS_DIR, "test-usdc-mint.json");

// State file paths
export const STATE_FILE = resolve(STATE_DIR, "state.json");
export const RUN_LOG = resolve(LOGS_DIR, "run.log");

export const SMOKE_RPC_URL = "http://127.0.0.1:8899";
export const PUBSUB_PROJECT = "pact-smoke";
export const PUBSUB_TOPIC = "pact-settle-events";
export const PUBSUB_SUBSCRIPTION = "pact-settle-events-settler";
export const PUBSUB_EMULATOR_HOST = "127.0.0.1:8085";
export const INDEXER_URL = "http://127.0.0.1:3091";
export const INDEXER_PUSH_SECRET = "smoke-test-secret-do-not-use-in-prod";

export const ENDPOINTS = [
  { slug: "smoke-ep1", flatPremium: 1_000n, percentBps: 100, sla: 1000 },
  { slug: "smoke-ep2", flatPremium: 2_000n, percentBps: 150, sla: 1500 },
  { slug: "smoke-ep3", flatPremium: 1_500n, percentBps: 75,  sla: 800  },
  { slug: "smoke-ep4", flatPremium: 3_000n, percentBps: 200, sla: 2000 },
  { slug: "smoke-ep5", flatPremium: 500n,   percentBps: 50,  sla: 500  },
] as const;

export const NUM_AGENTS = 5;
export const USDC_PER_AGENT_LAMPORTS = 1_000n * 1_000_000n; // 1000 USDC

// Use the canonical devnet USDC since surfpool can fork it AND our program
// hardcodes USDC_DEVNET as the only accepted mint. We use surfnet_setTokenAccount
// to mint to test agents (no mint authority needed).
export const USDC_DEVNET_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
