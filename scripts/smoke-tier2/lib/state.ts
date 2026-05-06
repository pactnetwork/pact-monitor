/**
 * Smoke run state — persisted to `.smoke-state/state.json` so each script can
 * be re-run independently without losing prior step output (program ID,
 * test USDC mint, derived PDAs, batch counts, etc.).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { STATE_FILE } from "./paths";

export interface SmokeState {
  programId?: string;
  testUsdcMint?: string;
  protocolAuthority?: string;
  settlementAuthoritySigner?: string;
  protocolConfigPda?: string;
  treasuryPda?: string;
  treasuryVault?: string;
  settlementAuthorityPda?: string;
  endpoints?: Array<{
    slug: string;
    endpointConfigPda: string;
    coveragePool: string;
    poolVault: string;
  }>;
  agents?: Array<{
    index: number;
    pubkey: string;
    ata: string;
  }>;
  /** Tx signatures, keyed by step. */
  signatures?: Record<string, string>;
  /** Number of batches the settler submitted (filled by 06-reconcile). */
  totalBatches?: number;
  /** Number of events fired (filled by 05-fire-50-calls). */
  totalEventsFired?: number;
}

export function loadState(): SmokeState {
  if (!existsSync(STATE_FILE)) return {};
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as SmokeState;
}

export function saveState(s: SmokeState): void {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n", "utf8");
}

export function patchState(p: Partial<SmokeState>): SmokeState {
  const cur = loadState();
  const next = { ...cur, ...p, signatures: { ...cur.signatures, ...p.signatures } };
  saveState(next);
  return next;
}
