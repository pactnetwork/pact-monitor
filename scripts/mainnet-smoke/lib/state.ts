/**
 * Persistent run state for the mainnet smoke harness, mirrored on
 * scripts/mainnet/lib/state.ts but written under
 * `scripts/mainnet-smoke/.smoke-state/state.json` so each step can be
 * re-run independently and the reconciler can read what fire produced.
 *
 * Gitignored — see scripts/mainnet-smoke/.gitignore.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STATE_DIR = resolve(__dirname, "..", ".smoke-state");
const STATE_PATH = resolve(STATE_DIR, "state.json");

export type CallOutcome = "ok" | "latency" | "server_error" | "network_error";

export interface FiredCall {
  /** 32-char hex callId emitted to wrap (matches indexer/Call.id format). */
  callId: string;
  slug: string;
  expectedOutcome: CallOutcome;
  /** Wall-clock ms when the proxy was hit. */
  sentAtMs: number;
  /** HTTP status of the proxy response, or 0 if a network error tripped first. */
  proxyStatus: number;
  /** Premium per X-Pact-Premium response header (lamports). */
  premiumLamports: string;
  /** Refund per X-Pact-Refund response header (lamports). */
  refundLamports: string;
  /** Outcome string per X-Pact-Outcome response header. */
  outcomeHeader: string;
}

export interface MainnetSmokeState {
  testAgentPubkey?: string;
  startedAt?: string;
  firedAt?: string;
  reconciledAt?: string;
  calls?: FiredCall[];
  /** snapshot of pre-fire on-chain pool balances per slug, lamports. */
  preFirePoolBalances?: Record<string, string>;
  /** snapshot of pre-fire on-chain treasury vault USDC balance, lamports. */
  preFireTreasuryVaultBalance?: string;
}

export function readState(): MainnetSmokeState {
  if (!existsSync(STATE_PATH)) return {};
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as MainnetSmokeState;
}

export function patchState(
  patch: Partial<MainnetSmokeState>,
): MainnetSmokeState {
  const cur = readState();
  const next: MainnetSmokeState = { ...cur, ...patch };
  if (!cur.startedAt) next.startedAt = new Date().toISOString();
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

export function statePath(): string {
  return STATE_PATH;
}
