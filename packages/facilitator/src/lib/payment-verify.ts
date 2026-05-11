// On-chain verification of the x402/MPP payment the agent already made to the
// merchant before calling the facilitator.
//
// The CLI sends `paymentSignature` (the Solana tx signature `pay` submitted),
// `payee` (the merchant wallet pubkey), `amountBaseUnits` and `asset` (the
// mint). The facilitator must confirm — against chain — that this transaction
// actually moved AT LEAST `amountBaseUnits` of `asset` into an account owned by
// `payee`, and that the transaction succeeded. Without this a caller could
// claim coverage for a payment that never happened.
//
// Approach: fetch the (parsed) transaction, require it to be confirmed/
// finalised with no error, then read its `meta.preTokenBalances` /
// `meta.postTokenBalances` and look for a token account whose `mint === asset`
// and `owner === payee` whose UI-amount-as-raw INCREASED by >= amountBaseUnits.
// This is robust to transfer / transferChecked / multi-hop / CPI'd transfers —
// it only looks at the net balance delta the validator recorded, which is the
// ground truth of what moved.
//
// Known limitations / TODOs (documented loudly per the task brief):
//   - We only assert the *payee* received the funds; we do NOT assert the
//     *agent* (x-pact-agent) was the *source*. The agent is already
//     cryptographically bound by the ed25519 envelope on the register call, so
//     a malicious agent claiming someone else's payment gains nothing (the
//     premium is debited from THEIR allowance, the refund goes to THEIR ATA —
//     so they'd be paying a premium to insure a stranger's call). Still, a
//     follow-up should also verify `meta.preTokenBalances` shows a matching
//     DECREASE on an account owned by the agent. Filed as a TODO.
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
  | "rpc_error";

export interface VerifyPaymentArgs {
  connection: Connection;
  /** Base58 tx signature `pay` submitted. */
  paymentSignature: string;
  /** Merchant wallet pubkey (bs58) — the OWNER of the receiving token account. */
  payee: string;
  /** Token mint (bs58) — for the MVP, the network's USDC mint. */
  asset: string;
  /** Minimum base units the payee must have received. */
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
  const { connection, paymentSignature, payee, asset, amountBaseUnits } = args;

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

  // Index pre-balances by accountIndex for O(1) lookup of the delta.
  const preByIdx = new Map<number, TokenBalanceEntry>();
  for (const p of pre) preByIdx.set(p.accountIndex, p);

  for (const p of post) {
    if (p.mint !== asset) continue;
    if (p.owner !== payee) continue;
    const before = BigInt(preByIdx.get(p.accountIndex)?.uiTokenAmount.amount ?? "0");
    const after = BigInt(p.uiTokenAmount.amount);
    const delta = after - before;
    if (delta >= amountBaseUnits) {
      return { ok: true, observedAmount: delta };
    }
  }

  // Also handle the case where the payee's token account did NOT exist before
  // the tx (so it's absent from preTokenBalances entirely but present in
  // postTokenBalances with the full amount) — covered above since
  // `preByIdx.get(...) ?? "0"` already treats that as a zero starting balance.
  return { ok: false, reason: "no_matching_transfer" };
}
