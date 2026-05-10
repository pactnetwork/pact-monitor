import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dump as yamlDump, load as yamlLoad } from "js-yaml";

export interface Policy {
  auto_deposit: {
    enabled: boolean;
    per_deposit_max_usdc: number;
    session_total_max_usdc: number;
  };
}

export const defaultPolicy: Policy = {
  auto_deposit: {
    enabled: true,
    per_deposit_max_usdc: 1.0,
    session_total_max_usdc: 5.0,
  },
};

export function loadOrCreatePolicy(opts: { configDir: string }): Policy {
  const path = join(opts.configDir, "policy.yaml");
  if (existsSync(path)) {
    return yamlLoad(readFileSync(path, "utf8")) as Policy;
  }
  if (!existsSync(opts.configDir)) {
    mkdirSync(opts.configDir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(path, yamlDump(defaultPolicy), { mode: 0o644 });
  return defaultPolicy;
}

interface SessionState {
  total_usdc: number;
  session_id: string;
  started_at: string;
}

function sessionPath(configDir: string): string {
  return join(configDir, "auto_deposits_session.json");
}

function loadSessionState(configDir: string): SessionState {
  const path = sessionPath(configDir);
  if (!existsSync(path)) {
    return {
      total_usdc: 0,
      session_id: process.env.PACT_SESSION_ID ?? cryptoRandomId(),
      started_at: new Date().toISOString(),
    };
  }
  return JSON.parse(readFileSync(path, "utf8")) as SessionState;
}

function saveSessionState(configDir: string, state: SessionState): void {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(sessionPath(configDir), JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
}

function cryptoRandomId(): string {
  return crypto.randomUUID();
}

export function recordAutoDeposit(opts: {
  configDir: string;
  amountUsdc: number;
}): void {
  const s = loadSessionState(opts.configDir);
  s.total_usdc += opts.amountUsdc;
  saveSessionState(opts.configDir, s);
}

export type AutoDepositCheck =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "policy_disabled"
        | "env_disabled"
        | "per_deposit_exceeded"
        | "session_total_exceeded";
      session_used_usdc: number;
      session_max_usdc: number;
      per_deposit_max_usdc: number;
    };

export function canAutoDeposit(opts: {
  configDir: string;
  policy: Policy;
  requestedUsdc: number;
}): AutoDepositCheck {
  const session = loadSessionState(opts.configDir);
  const meta = {
    session_used_usdc: session.total_usdc,
    session_max_usdc: opts.policy.auto_deposit.session_total_max_usdc,
    per_deposit_max_usdc: opts.policy.auto_deposit.per_deposit_max_usdc,
  };
  if (process.env.PACT_AUTO_DEPOSIT_DISABLED === "1") {
    return { allowed: false, reason: "env_disabled", ...meta };
  }
  if (!opts.policy.auto_deposit.enabled) {
    return { allowed: false, reason: "policy_disabled", ...meta };
  }
  if (opts.requestedUsdc > opts.policy.auto_deposit.per_deposit_max_usdc) {
    return { allowed: false, reason: "per_deposit_exceeded", ...meta };
  }
  if (
    session.total_usdc + opts.requestedUsdc >
    opts.policy.auto_deposit.session_total_max_usdc
  ) {
    return { allowed: false, reason: "session_total_exceeded", ...meta };
  }
  return { allowed: true };
}
