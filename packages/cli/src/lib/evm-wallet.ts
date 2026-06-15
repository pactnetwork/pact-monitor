import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  generatePrivateKey,
  privateKeyToAccount,
} from "viem/accounts";
import type { Hex } from "viem";

export interface EvmWalletLoadResult {
  address: `0x${string}`;
  privateKey: Hex;
  source: "disk" | "env" | "flag";
  /** Path the wallet was read from (or written to on fresh-gen). */
  path: string;
  /** True on the first invocation that just generated + persisted the key. */
  created: boolean;
}

const EVM_KEY_ERROR =
  "EVM key must be a 0x-prefixed 32-byte hex private key, a JSON object {privateKey: '0x...'}, or a path to a file containing either";

/** Disk filename for the shared (cross-chain) EVM wallet. */
export function sharedEvmWalletPath(configDir: string): string {
  return join(configDir, "evm-wallet.json");
}

/** Disk filename for a per-chain EVM wallet override. */
export function chainEvmWalletPath(configDir: string, network: string): string {
  return join(configDir, `evm-wallet-${network}.json`);
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function normaliseHex(input: string): Hex {
  const trimmed = input.trim();
  const withPrefix = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  // viem will validate the length when we call privateKeyToAccount; here we
  // just enforce shape so a malformed string fails with the clear message.
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error(EVM_KEY_ERROR);
  }
  return withPrefix as Hex;
}

/**
 * Parse an EVM private-key input that may be:
 *  - a 0x-prefixed (or bare) 32-byte hex string;
 *  - a JSON object `{ "privateKey": "0x..." }` (the on-disk wallet shape, and
 *    the shape Tu's existing test key uses at ~/.config/pact/pact-smoke/evm-wallet.json);
 *  - a path to a regular file containing either of the above.
 *
 * `depth` guards against pathological symlink/file loops, mirroring
 * parseSecretKeyInput in wallet.ts.
 */
export function parseEvmPrivateKeyInput(input: string, depth = 0): Hex {
  const trimmed = input.trim();
  if (!trimmed) throw new Error(EVM_KEY_ERROR);

  // 1. JSON object holding { privateKey, address? }.
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(EVM_KEY_ERROR);
    }
    if (
      parsed &&
      typeof parsed === "object" &&
      "privateKey" in parsed &&
      typeof (parsed as { privateKey: unknown }).privateKey === "string"
    ) {
      return normaliseHex((parsed as { privateKey: string }).privateKey);
    }
    throw new Error(EVM_KEY_ERROR);
  }

  // 2. Path to an existing readable file containing either format.
  if (depth < 4) {
    const candidate = expandHome(trimmed);
    if (isRegularFile(candidate)) {
      let contents: string;
      try {
        contents = readFileSync(candidate, "utf8");
      } catch {
        throw new Error(EVM_KEY_ERROR);
      }
      return parseEvmPrivateKeyInput(contents, depth + 1);
    }
  }

  // 3. Bare hex (with or without 0x prefix).
  return normaliseHex(trimmed);
}

/** Build an account object from any supported EVM key input. */
export function accountFromInput(input: string): {
  address: `0x${string}`;
  privateKey: Hex;
} {
  const pk = parseEvmPrivateKeyInput(input);
  const acct = privateKeyToAccount(pk);
  return { address: acct.address, privateKey: pk };
}

export interface LoadEvmWalletOpts {
  configDir: string;
  /** Target network — controls which override file wins (if any). */
  network: string;
  /** Explicit key file path/contents (from `--keypair`); beats env and disk. */
  keypairPath?: string;
  /** Override for the env var (defaults to PACT_EVM_PRIVATE_KEY at call time). */
  envOverride?: string;
}

/**
 * Resolve the EVM wallet for a given network.
 *
 * Precedence: `--keypair` (keypairPath) > PACT_EVM_PRIVATE_KEY env >
 * per-chain `evm-wallet-<network>.json` > shared `evm-wallet.json` >
 * generate fresh shared wallet (caller halts to surface address + faucet hint).
 */
export function loadEvmWallet(opts: LoadEvmWalletOpts): EvmWalletLoadResult {
  if (opts.keypairPath) {
    const a = accountFromInput(opts.keypairPath);
    return {
      address: a.address,
      privateKey: a.privateKey,
      source: "flag",
      path: opts.keypairPath,
      created: false,
    };
  }

  const envValue = opts.envOverride ?? process.env.PACT_EVM_PRIVATE_KEY;
  if (envValue) {
    const a = accountFromInput(envValue);
    return {
      address: a.address,
      privateKey: a.privateKey,
      source: "env",
      path: "",
      created: false,
    };
  }

  const perChain = chainEvmWalletPath(opts.configDir, opts.network);
  if (existsSync(perChain)) {
    const a = accountFromInput(readFileSync(perChain, "utf8"));
    return {
      address: a.address,
      privateKey: a.privateKey,
      source: "disk",
      path: perChain,
      created: false,
    };
  }

  const shared = sharedEvmWalletPath(opts.configDir);
  if (existsSync(shared)) {
    const a = accountFromInput(readFileSync(shared, "utf8"));
    return {
      address: a.address,
      privateKey: a.privateKey,
      source: "disk",
      path: shared,
      created: false,
    };
  }

  if (!existsSync(opts.configDir)) {
    mkdirSync(opts.configDir, { recursive: true, mode: 0o700 });
  }
  const pk = generatePrivateKey();
  const acct = privateKeyToAccount(pk);
  writeFileSync(
    shared,
    JSON.stringify({ address: acct.address, privateKey: pk }, null, 2),
    { mode: 0o600 },
  );
  chmodSync(shared, 0o600);
  return {
    address: acct.address,
    privateKey: pk,
    source: "disk",
    path: shared,
    created: true,
  };
}
