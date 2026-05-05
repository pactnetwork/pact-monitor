import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  type TransactionSignature,
} from "@solana/web3.js";
import {
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import {
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { getSolanaConfig, loadFaucetKeypair } from "../utils/solana.js";
import { getCachedNetwork, isMainnet } from "../utils/network.js";
import { query } from "../db.js";

// Max drip per request. Server-authoritative — the client is allowed to pick
// amount within [1, MAX] but any request outside the window is a 400. Keeps
// abuse bounded even if rate-limit plugin ever gets bypassed (e.g. restart
// wipes the in-memory window).
export const MAX_DRIP_USDC = 10_000;
export const MIN_DRIP_USDC = 1;

// USDC has 6 decimals; 1 whole USDC = 1_000_000 base units.
const USDC_DECIMALS = 6;

// SOL top-up policy (PR 2). When the recipient has less than this much SOL,
// the drip transfers SOL_TOP_UP_LAMPORTS alongside the USDC mint. This
// removes the "now go run `solana airdrop`" hop for first-time agents whose
// devnet airdrops are 429ing on the public faucet.
//
// Threshold of 0.01 SOL covers the rent for an enable_insurance + a few
// records-route signatures. SOL_TOP_UP_LAMPORTS gives the agent ~25 typical
// txs of headroom. Both are conservative — the goal is "enough to finish
// the demo", not "enough to live on devnet."
const SOL_TOP_UP_THRESHOLD_LAMPORTS = 0.01 * LAMPORTS_PER_SOL;
const SOL_TOP_UP_LAMPORTS = 0.05 * LAMPORTS_PER_SOL;
// Minimum SOL the faucet keypair must retain after a top-up. Below this,
// dripUsdc skips the SOL leg and logs a warning so ops gets paged before
// the keypair drains to zero. The USDC mint leg still proceeds — minting
// USDC doesn't actually deduct SOL beyond the tx fee.
const FAUCET_MIN_RESERVE_LAMPORTS = 0.1 * LAMPORTS_PER_SOL;

export class FaucetDisabledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "FaucetDisabledError";
  }
}

export class InvalidRecipientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRecipientError";
  }
}

export class AmountOutOfRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmountOutOfRangeError";
  }
}

export interface DripResult {
  signature: TransactionSignature;
  amount: number; // whole USDC
  recipient: string;
  ata: string;
  network: string;
  explorer: string;
  // Lamports of SOL transferred to the recipient on this drip. 0 means the
  // recipient was already above the SOL_TOP_UP_THRESHOLD or the faucet
  // keypair was below its reserve. Lets the client log "got 0.05 SOL" or
  // skip a separate `solana airdrop` step entirely.
  solTransferred: number;
  // Faucet keypair's SOL balance AFTER this drip, in lamports. Surfaced so
  // ops can monitor headroom — once it dips below FAUCET_MIN_RESERVE_LAMPORTS
  // the SOL leg silently turns off.
  faucetSolBalance: number;
}

export interface FaucetStatus {
  enabled: boolean;
  network: string;
  maxPerDrip: number;
  minPerDrip: number;
  mint: string;
  reason?: string;
}

// Resolves once what the /status endpoint should return. Cheap enough to call
// on every request — no caching beyond what the underlying helpers already do.
export function getFaucetStatus(): FaucetStatus {
  const network = getCachedNetwork();
  const config = getSolanaConfig();

  // Faucet is devnet/localnet only. Any other network (mainnet, testnet,
  // unknown) returns enabled:false with an explicit reason so the client can
  // show something useful.
  if (network === "mainnet-beta") {
    return {
      enabled: false,
      network,
      maxPerDrip: MAX_DRIP_USDC,
      minPerDrip: MIN_DRIP_USDC,
      mint: config.usdcMint,
      reason: "Faucet is devnet-only and cannot mint on mainnet-beta",
    };
  }
  if (network === "testnet") {
    return {
      enabled: false,
      network,
      maxPerDrip: MAX_DRIP_USDC,
      minPerDrip: MIN_DRIP_USDC,
      mint: config.usdcMint,
      reason: "Faucet is devnet-only — this backend is pointed at testnet",
    };
  }
  if (network === "unknown") {
    return {
      enabled: false,
      network,
      maxPerDrip: MAX_DRIP_USDC,
      minPerDrip: MIN_DRIP_USDC,
      mint: config.usdcMint,
      reason: "Network detection failed; faucet disabled as a safety default",
    };
  }

  // Fail closed if the faucet keypair env is unset — makes the common "I
  // forgot to set FAUCET_KEYPAIR_*" misconfiguration return a clear status
  // message instead of a 500 at drip time.
  if (!config.faucetKeypairBase58 && !config.faucetKeypairPath) {
    return {
      enabled: false,
      network,
      maxPerDrip: MAX_DRIP_USDC,
      minPerDrip: MIN_DRIP_USDC,
      mint: config.usdcMint,
      reason: "FAUCET_KEYPAIR_BASE58 / FAUCET_KEYPAIR_PATH is not configured",
    };
  }

  return {
    enabled: true,
    network,
    maxPerDrip: MAX_DRIP_USDC,
    minPerDrip: MIN_DRIP_USDC,
    mint: config.usdcMint,
  };
}

// Exposed for tests + ops monitoring. Pure decision: given the recipient's
// current SOL balance and the faucet keypair's current SOL balance, should
// dripUsdc piggyback a SOL transfer onto this drip? Centralized so the
// route handler, tests, and any future "do I need to ask ops to top up?"
// telemetry all read the same rule.
export function shouldTopUpSol(
  recipientLamports: number,
  faucetLamports: number,
): { topUp: boolean; lamports: number; reason: string } {
  if (recipientLamports >= SOL_TOP_UP_THRESHOLD_LAMPORTS) {
    return { topUp: false, lamports: 0, reason: "recipient already has enough SOL" };
  }
  if (faucetLamports <= FAUCET_MIN_RESERVE_LAMPORTS + SOL_TOP_UP_LAMPORTS) {
    return {
      topUp: false,
      lamports: 0,
      reason: "faucet keypair below reserve — page ops to top up",
    };
  }
  return { topUp: true, lamports: SOL_TOP_UP_LAMPORTS, reason: "ok" };
}

// Exposed for tests so they can read the constants without importing them
// from the module file (which would couple every test to internal renames).
export const __faucetSolPolicyForTests = {
  thresholdLamports: SOL_TOP_UP_THRESHOLD_LAMPORTS,
  topUpLamports: SOL_TOP_UP_LAMPORTS,
  minReserveLamports: FAUCET_MIN_RESERVE_LAMPORTS,
};

// Exported for direct unit testing of the pure validation rules.
export function validateRecipient(raw: string): PublicKey {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new InvalidRecipientError("recipient is required");
  }
  try {
    const pk = new PublicKey(raw);
    // PublicKey accepts 32-byte arrays too; guard the string form explicitly.
    if (!PublicKey.isOnCurve(pk.toBytes())) {
      throw new InvalidRecipientError(
        "recipient must be a wallet address (on-curve ed25519 pubkey), not a PDA",
      );
    }
    return pk;
  } catch (err) {
    if (err instanceof InvalidRecipientError) throw err;
    throw new InvalidRecipientError(`recipient is not a valid base58 pubkey: ${(err as Error).message}`);
  }
}

// Exported for direct unit testing of the pure validation rules.
export function validateAmount(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    throw new AmountOutOfRangeError("amount must be a positive integer (whole USDC)");
  }
  if (raw < MIN_DRIP_USDC || raw > MAX_DRIP_USDC) {
    throw new AmountOutOfRangeError(
      `amount must be between ${MIN_DRIP_USDC} and ${MAX_DRIP_USDC} whole USDC`,
    );
  }
  return raw;
}

export interface DripArgs {
  recipient: string;
  amount: number;
  ip?: string;
}

export async function dripUsdc(args: DripArgs): Promise<DripResult> {
  // Mainnet/unknown network gate. Doing the check here and not just in the
  // route handler guarantees a service-level caller (script, test, future
  // route) can't sidestep the lockout.
  if (isMainnet() || getCachedNetwork() === "unknown") {
    throw new FaucetDisabledError(
      "Faucet disabled on this network (mainnet or unknown). Drip refused.",
    );
  }

  const recipientPk = validateRecipient(args.recipient);
  const amount = validateAmount(args.amount);

  const config = getSolanaConfig();
  const faucetKeypair = loadFaucetKeypair(config);
  const connection = new Connection(config.rpcUrl, "confirmed");
  const mint = new PublicKey(config.usdcMint);

  // Ensure the recipient has a token account for this mint; create it (paid
  // by the faucet) if they don't. The faucet eats the ~0.002 SOL rent so first
  // -time users don't need SOL to claim USDC. Idempotent.
  const recipientAta = await getOrCreateAssociatedTokenAccount(
    connection,
    faucetKeypair,
    mint,
    recipientPk,
  );

  // Convert whole USDC → base units (6 decimals). BigInt is required because
  // 10_000 * 1_000_000 overflows safe integer math only at ~9 trillion — but
  // spl-token's typings expect bigint | number anyway.
  const baseUnits = BigInt(amount) * BigInt(10 ** USDC_DECIMALS);

  const mintIx = createMintToInstruction(
    mint,
    recipientAta.address,
    faucetKeypair.publicKey,
    baseUnits,
  );

  // SOL top-up: piggyback on the same tx if the recipient is below the
  // threshold AND the faucet has enough headroom. Skipping the SOL leg
  // (rather than failing the whole drip) keeps the USDC drip working even
  // when the faucet is running low — ops sees the warning, the user still
  // gets USDC.
  let solTransferred = 0;
  let faucetSolBefore = 0;
  try {
    faucetSolBefore = await connection.getBalance(faucetKeypair.publicKey, "confirmed");
  } catch {
    // If we can't read the faucet balance, fall through with solTransferred=0.
    // Better to ship USDC than to fail closed on a transient RPC blip.
  }
  let recipientSolBefore = 0;
  try {
    recipientSolBefore = await connection.getBalance(recipientPk, "confirmed");
  } catch {
    // Same reasoning — degrade gracefully.
  }

  const tx = new Transaction().add(mintIx);
  const decision = shouldTopUpSol(recipientSolBefore, faucetSolBefore);
  if (decision.topUp) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: faucetKeypair.publicKey,
        toPubkey: recipientPk,
        lamports: decision.lamports,
      }),
    );
    solTransferred = decision.lamports;
  }

  const signature = await sendAndConfirmTransaction(connection, tx, [faucetKeypair], {
    commitment: "confirmed",
  });

  const network = getCachedNetwork();

  // Re-read the faucet balance post-drip so the response reflects reality
  // and ops can chart this over time. Best-effort — falls back to the
  // pre-drip balance minus what we just sent.
  let faucetSolAfter = Math.max(0, faucetSolBefore - solTransferred);
  try {
    faucetSolAfter = await connection.getBalance(faucetKeypair.publicKey, "confirmed");
  } catch {
    // ignore — best-effort
  }

  // Audit row — no uniqueness, no enforcement. Purely for "who got what" on
  // the devnet mint so we can retrospectively notice abuse patterns.
  await query(
    `INSERT INTO faucet_drips (recipient, amount, signature, network, ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      recipientPk.toBase58(),
      String(baseUnits),
      signature,
      network,
      args.ip ?? null,
    ],
  );

  const explorerCluster = network === "devnet" ? "?cluster=devnet" : "";
  const explorer = `https://explorer.solana.com/tx/${signature}${explorerCluster}`;

  return {
    signature,
    amount,
    recipient: recipientPk.toBase58(),
    ata: recipientAta.address.toBase58(),
    network,
    explorer,
    solTransferred,
    faucetSolBalance: faucetSolAfter,
  };
}

// Exposed for tests so they can call into the service without going through
// the route handler. Returns the ATA even if it already existed.
export async function __peekRecipientAtaForTests(recipient: string): Promise<string> {
  const pk = new PublicKey(recipient);
  const config = getSolanaConfig();
  const ata = getAssociatedTokenAddressSync(new PublicKey(config.usdcMint), pk);
  return ata.toBase58();
}
