// On-chain verification of the x402/MPP payment the agent already made to the
// merchant before calling the facilitator.
//
// The CLI sends `paymentSignature` (the Solana tx signature `pay` submitted),
// `payee` (the merchant wallet pubkey), `agent` (the claiming agent's wallet —
// also the payer), `amountBaseUnits` and `asset` (the mint). The facilitator
// must confirm — against chain — that this transaction (a) actually moved AT
// LEAST `amountBaseUnits` of `asset` into an account owned by `payee`, (b) was
// SOURCED from an account owned by `agent`, and (c) succeeded. Without (a) a
// caller could claim coverage for a payment that never happened; without (b) a
// caller could claim coverage for a STRANGER'S payment (see source-binding
// note below).
//
// Approach: fetch the (parsed) transaction, require it to be confirmed/
// finalised with no error, then read its `meta.preTokenBalances` /
// `meta.postTokenBalances` and look for a token account whose `mint === asset`
// and `owner === payee` whose UI-amount-as-raw INCREASED by >= amountBaseUnits,
// AND a token account whose `mint === asset` and `owner === agent` whose
// UI-amount-as-raw DECREASED by >= amountBaseUnits. This is robust to transfer
// / transferChecked / multi-hop / CPI'd transfers — it only looks at the net
// balance deltas the validator recorded, which are the ground truth of what
// moved.
//
// Source binding (agent-tasks#10, was a 🔴 hole): Solana tx signatures are
// public, so without the agent-side check an attacker could read a real
// payer's `paymentSignature` off-chain and re-register it under THEIR OWN
// `agent` identity. The payee-received check still passes (the payee really
// got paid), the deterministic `coverageId = sha256(payee||resource||sig)`
// excludes `agent` so the first registration LOCKS OUT the real payer, and the
// covered-breach refund pays the CLAIMING agent's ATA (settler derives it from
// `agentPubkey`). Premium (~1_000 base units) ≪ refund (up to ~1_000_000), so
// the attacker profits. The ed25519 envelope binds the *claimant*, not the
// *payer* — and they're only the same key if we PROVE it on-chain. In pay.sh's
// unified-wallet model (cli/src/lib/pay-wallet.ts) the wallet that pays the
// merchant IS the wallet that signs the register envelope, so a legitimate
// agent always shows the required decrease; an attacker replaying a stranger's
// payment never does. We enforce that here.
//
//   - `asset` is matched verbatim against the token-balance `mint`. For the
//     MVP only the network's USDC mint is in scope; a mint allowlist (USDC
//     mainnet/devnet) is enforced by the route handler before this is called.
//   - We don't bound how old `paymentSignature` may be. A replay of an ancient
//     payment is bounded by the deterministic `coverageId` (a given payment can
//     only ever register once) — but a stale-payment policy (reject payments
//     older than N minutes) is a reasonable follow-up.

import type { Connection } from "@solana/web3.js";

export type PaymentVerifyResult =
  | { ok: true; observedAmount: bigint }
  | { ok: false; reason: PaymentVerifyError };

export type PaymentVerifyError =
  | "tx_not_found"
  | "tx_failed"
  | "tx_not_confirmed"
  | "no_matching_transfer"
  | "agent_not_source"
  | "rpc_error";

export interface VerifyPaymentArgs {
  connection: Connection;
  /** Base58 tx signature `pay` submitted. */
  paymentSignature: string;
  /** Merchant wallet pubkey (bs58) — the OWNER of the receiving token account. */
  payee: string;
  /**
   * Claiming agent wallet pubkey (bs58) — the OWNER of the *paying* token
   * account. Source binding (agent-tasks#10): the tx must show a matching
   * DECREASE on an `asset` account owned by this key, proving the claimant
   * actually funded the payment and isn't replaying a stranger's signature.
   */
  agent: string;
  /** Token mint (bs58) — for the MVP, the network's USDC mint. */
  asset: string;
  /** Minimum base units the payee must have received (and the agent paid). */
  amountBaseUnits: bigint;
}

interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

export async function verifyPayment(
  args: VerifyPaymentArgs,
): Promise<PaymentVerifyResult> {
  const { connection, paymentSignature, payee, agent, asset, amountBaseUnits } =
    args;

  let tx;
  try {
    tx = await connection.getParsedTransaction(paymentSignature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
  } catch {
    return { ok: false, reason: "rpc_error" };
  }
  if (!tx) {
    return { ok: false, reason: "tx_not_found" };
  }
  // `getParsedTransaction` only returns confirmed/finalised txs; a processed-
  // but-not-confirmed tx comes back null. Belt-and-braces: also reject if the
  // meta says it errored.
  if (tx.meta?.err) {
    return { ok: false, reason: "tx_failed" };
  }

  const pre = (tx.meta?.preTokenBalances ?? []) as TokenBalanceEntry[];
  const post = (tx.meta?.postTokenBalances ?? []) as TokenBalanceEntry[];

  // Index by accountIndex for O(1) delta lookups in both directions.
  const preByIdx = new Map<number, TokenBalanceEntry>();
  for (const p of pre) preByIdx.set(p.accountIndex, p);
  const postByIdx = new Map<number, TokenBalanceEntry>();
  for (const p of post) postByIdx.set(p.accountIndex, p);

  // (a) Payee received >= amount. Look for an `asset` account owned by `payee`
  // whose balance INCREASED by at least the claimed amount. A payee account
  // that did NOT exist before the tx is absent from preTokenBalances; the
  // `?? "0"` treats that as a zero starting balance.
  let observedReceived: bigint | null = null;
  for (const p of post) {
    if (p.mint !== asset) continue;
    if (p.owner !== payee) continue;
    const before = BigInt(preByIdx.get(p.accountIndex)?.uiTokenAmount.amount ?? "0");
    const after = BigInt(p.uiTokenAmount.amount);
    const delta = after - before;
    if (delta >= amountBaseUnits) {
      observedReceived = delta;
      break;
    }
  }
  if (observedReceived === null) {
    return { ok: false, reason: "no_matching_transfer" };
  }

  // (b) Agent was the source (agent-tasks#10 source binding). Look for an
  // `asset` account owned by `agent` whose balance DECREASED by at least the
  // claimed amount. We scan PRE balances (the `owner` is recorded there) and
  // read the matching POST balance by accountIndex. An account present in pre
  // but ABSENT from post was closed — its balance went to 0, so `after = 0`
  // and the full pre-balance counts as the decrease. The decrease may exceed
  // `amountBaseUnits` (the agent can move more than the premium-relevant
  // amount in the same tx); we require `>=`.
  let agentIsSource = false;
  for (const p of pre) {
    if (p.mint !== asset) continue;
    if (p.owner !== agent) continue;
    const before = BigInt(p.uiTokenAmount.amount);
    const after = BigInt(postByIdx.get(p.accountIndex)?.uiTokenAmount.amount ?? "0");
    const decrease = before - after;
    if (decrease >= amountBaseUnits) {
      agentIsSource = true;
      break;
    }
  }
  if (!agentIsSource) {
    return { ok: false, reason: "agent_not_source" };
  }

  return { ok: true, observedAmount: observedReceived };
}
