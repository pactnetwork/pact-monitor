// Devnet init state file — twin of scripts/mainnet/lib/state.ts but lands
// the artifact at scripts/devnet/.devnet-state.json. Same shape so the
// mainnet runbook patterns (verification commands, deploy-stack steps)
// translate one-to-one.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = resolve(__dirname, "..", ".devnet-state.json");

export interface DevnetState {
  programId?: string;
  protocolAuthority?: string;
  settlementAuthoritySigner?: string;
  usdcMint?: string;
  protocolConfigPda?: string;
  treasuryPda?: string;
  treasuryVault?: string;
  settlementAuthorityPda?: string;
  endpoints?: Array<{
    slug: string;
    endpointConfigPda: string;
    coveragePool: string;
    poolVault: string;
    flatPremiumLamports: string;
    percentBps: number;
    slaLatencyMs: number;
    imputedCostLamports: string;
    exposureCapPerHourLamports: string;
  }>;
  signatures?: Record<string, string>;
  initializedAt?: string;
}

export function readState(): DevnetState {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

export function patchState(patch: Partial<DevnetState>): void {
  const cur = readState();
  const next: DevnetState = { ...cur, ...patch };
  if (!cur.initializedAt && Object.keys(patch).length > 0) {
    next.initializedAt = new Date().toISOString();
  }
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(next, null, 2) + "\n");
}

export function statePath(): string {
  return STATE_PATH;
}
