/**
 * Higher-level helpers consumers need on top of the raw instruction builders.
 *
 * - `defaultFeeRecipients` — produces the V1 default fan-out template.
 * - `validateFeeRecipients` — mirrors the on-chain invariants in `fee.rs` so
 *   callers can pre-flight a tx without hitting `ProgramError::Custom`.
 * - `accountListForBatch` — deduplicated AccountMeta list for `settle_batch`.
 * - `getAgentInsurableState` — combined ATA balance + delegate inspection.
 */
import {
  AccountMeta,
  Connection,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";

import {
  ABSOLUTE_FEE_BPS_CAP,
  MAX_FEE_RECIPIENTS,
  TOKEN_PROGRAM_ID,
} from "./constants.js";
import {
  EndpointConfig,
  FeeRecipient,
  FeeRecipientKind,
} from "./state.js";
import type { SettlementEvent } from "./instructions.js";

/**
 * Returns the V1 default fee_recipients template.
 *
 * - With `affiliateAta` undefined: `[Treasury 10%]` (count=1).
 * - With `affiliateAta` set: `[Treasury 10%, Affiliate 5%]` (count=2).
 *
 * The `Treasury` entry's destination is set to the supplied `treasuryVault` —
 * informational, since `register_endpoint` substitutes it with the on-chain
 * Treasury.usdc_vault. Pass the canonical Treasury vault for clarity.
 */
export function defaultFeeRecipients(
  treasuryVault: PublicKey,
  affiliateAta?: PublicKey
): { fee_recipients: FeeRecipient[]; fee_recipient_count: number } {
  const fee_recipients: FeeRecipient[] = [
    {
      kind: FeeRecipientKind.Treasury,
      destination: treasuryVault.toBase58(),
      bps: 1000, // 10%
    },
  ];
  if (affiliateAta) {
    fee_recipients.push({
      kind: FeeRecipientKind.AffiliateAta,
      destination: affiliateAta.toBase58(),
      bps: 500, // 5%
    });
  }
  return {
    fee_recipients,
    fee_recipient_count: fee_recipients.length,
  };
}

/**
 * Run the same validation invariants the on-chain program enforces in
 * `fee.rs::parse_and_validate`.
 *
 * Returns `{ valid: false, reason }` for the first failure encountered. If the
 * arguments are valid, `{ valid: true }`.
 */
export function validateFeeRecipients(
  recipients: FeeRecipient[],
  count: number,
  maxTotalFeeBps: number
): { valid: boolean; reason?: string } {
  if (count !== recipients.length) {
    return {
      valid: false,
      reason: `count (${count}) must equal recipients.length (${recipients.length})`,
    };
  }
  if (count > MAX_FEE_RECIPIENTS) {
    return {
      valid: false,
      reason: `FeeRecipientArrayTooLong: ${count} > ${MAX_FEE_RECIPIENTS}`,
    };
  }
  if (maxTotalFeeBps > ABSOLUTE_FEE_BPS_CAP) {
    return {
      valid: false,
      reason: `FeeBpsExceedsCap: maxTotalFeeBps (${maxTotalFeeBps}) > ${ABSOLUTE_FEE_BPS_CAP}`,
    };
  }
  let sum = 0;
  let treasurySeen = false;
  const seenDest = new Set<string>();
  for (const r of recipients) {
    if (
      r.kind !== FeeRecipientKind.Treasury &&
      r.kind !== FeeRecipientKind.AffiliateAta &&
      r.kind !== FeeRecipientKind.AffiliatePda
    ) {
      return { valid: false, reason: `InvalidFeeRecipientKind: ${r.kind}` };
    }
    if (r.bps > ABSOLUTE_FEE_BPS_CAP) {
      return {
        valid: false,
        reason: `FeeBpsExceedsCap: entry bps (${r.bps}) > ${ABSOLUTE_FEE_BPS_CAP}`,
      };
    }
    if (r.kind === FeeRecipientKind.Treasury) {
      if (treasurySeen) {
        return { valid: false, reason: "MultipleTreasuryRecipients" };
      }
      treasurySeen = true;
    }
    if (seenDest.has(r.destination)) {
      return {
        valid: false,
        reason: `FeeRecipientDuplicateDestination: ${r.destination}`,
      };
    }
    seenDest.add(r.destination);
    sum += r.bps;
  }
  if (sum > ABSOLUTE_FEE_BPS_CAP) {
    return { valid: false, reason: `FeeBpsSumOver10k: sum=${sum}` };
  }
  if (sum > maxTotalFeeBps) {
    return {
      valid: false,
      reason: `FeeBpsExceedsCap: sum (${sum}) > maxTotalFeeBps (${maxTotalFeeBps})`,
    };
  }
  return { valid: true };
}

/**
 * Build the deduplicated AccountMeta list for a `settle_batch` transaction.
 *
 * The settle_batch on-chain handler expects a position-by-position match
 * between the per-event slots in the accounts array and the per-event records
 * in the data buffer. This helper produces exactly that — the exact ordering
 * and writability the program reads, with no deduplication of slots that are
 * intentionally repeated across events (each event stamps its own
 * call_record + endpoint + pool slots even if the slug repeats; the program
 * re-reads each).
 *
 * Use with `buildSettleBatchIx` — pass the resulting events (in the same
 * order) plus the pre-derived call_record PDAs.
 *
 * Note: the program deserialises strictly positionally, so this helper is a
 * convenience for assembling the `keys` array on the client side. If callers
 * need cross-event deduplication for tx size optimisation in a future
 * V2, that's a separate problem — the current program does NOT support it.
 */
export function accountListForBatch(
  events: SettlementEvent[],
  callRecordPdas: PublicKey[],
  settler: PublicKey,
  settlementAuthority: PublicKey
): AccountMeta[] {
  if (events.length !== callRecordPdas.length) {
    throw new Error(
      `events (${events.length}) and callRecordPdas (${callRecordPdas.length}) must align`
    );
  }
  const keys: AccountMeta[] = [
    { pubkey: settler, isSigner: true, isWritable: true },
    { pubkey: settlementAuthority, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    keys.push({ pubkey: callRecordPdas[i], isSigner: false, isWritable: true });
    keys.push({ pubkey: ev.coveragePool, isSigner: false, isWritable: true });
    keys.push({ pubkey: ev.poolVault, isSigner: false, isWritable: true });
    keys.push({ pubkey: ev.endpointConfig, isSigner: false, isWritable: true });
    keys.push({ pubkey: ev.agentAta, isSigner: false, isWritable: true });
    for (const fa of ev.feeRecipientAtas) {
      keys.push({ pubkey: fa, isSigner: false, isWritable: true });
    }
  }
  return keys;
}

/**
 * Cross-reference an EndpointConfig and a list of fee recipient ATAs to verify
 * they match in count + ordering. Useful as a settler pre-flight.
 */
export function feeAtasMatchEndpoint(
  endpoint: EndpointConfig,
  feeRecipientAtas: PublicKey[]
): { valid: boolean; reason?: string } {
  if (feeRecipientAtas.length !== endpoint.feeRecipientCount) {
    return {
      valid: false,
      reason: `count mismatch: endpoint=${endpoint.feeRecipientCount} provided=${feeRecipientAtas.length}`,
    };
  }
  for (let i = 0; i < endpoint.feeRecipientCount; i++) {
    const expected = endpoint.feeRecipients[i].destination;
    if (feeRecipientAtas[i].toBase58() !== expected) {
      return {
        valid: false,
        reason: `slot ${i} mismatch: expected ${expected} got ${feeRecipientAtas[i].toBase58()}`,
      };
    }
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Agent insurable state
// ---------------------------------------------------------------------------

const SPL_TOKEN_ACCOUNT_LEN = 165;

function readSplTokenAta(
  data: Uint8Array
): { mint: PublicKey; owner: PublicKey; amount: bigint; delegate: PublicKey | null; delegatedAmount: bigint } {
  if (data.length < SPL_TOKEN_ACCOUNT_LEN) {
    throw new Error(
      `SPL Token account expected ${SPL_TOKEN_ACCOUNT_LEN} bytes, got ${data.length}`
    );
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const mint = new PublicKey(data.slice(0, 32));
  const owner = new PublicKey(data.slice(32, 64));
  const amount = view.getBigUint64(64, true);
  const delegateOpt = view.getUint32(72, true);
  const delegate =
    delegateOpt === 1 ? new PublicKey(data.slice(76, 108)) : null;
  const delegatedAmount = view.getBigUint64(121, true);
  return { mint, owner, amount, delegate, delegatedAmount };
}

export interface AgentInsurableState {
  /** Spendable balance in the agent's USDC ATA. */
  ataBalance: bigint;
  /** Currently-delegated allowance to SettlementAuthority (0 if none). */
  allowance: bigint;
  /** Whether the agent has both balance >= required AND allowance >= required. */
  eligible: boolean;
  /** Human-readable reason when `eligible == false`. */
  reason?: string;
  /** The ATA pubkey we inspected. */
  ata: PublicKey;
}

/**
 * Inspect an agent's USDC ATA and report whether they have enough balance and
 * allowance for the program to debit `requiredLamports` worth of premium
 * during the next settle_batch.
 *
 * Returns `eligible: false` with a reason when:
 * - The ATA does not exist on-chain
 * - The mint does not match `usdcMint`
 * - The owner does not match `agentOwner`
 * - The delegate is not the SettlementAuthority PDA
 * - The delegated amount or balance is below `requiredLamports`
 */
export async function getAgentInsurableState(
  connection: Connection,
  agentOwner: PublicKey,
  usdcMint: PublicKey,
  settlementAuthorityPda: PublicKey,
  requiredLamports: bigint
): Promise<AgentInsurableState> {
  // Derive ATA via the standard associated_token_program PDA so we don't pull
  // in @solana/spl-token as a runtime dependency.
  const ata = deriveAssociatedTokenAccount(agentOwner, usdcMint);
  const acct = await connection.getAccountInfo(ata);
  if (!acct) {
    return {
      ataBalance: 0n,
      allowance: 0n,
      eligible: false,
      reason: "agent ATA does not exist",
      ata,
    };
  }
  if (!acct.owner.equals(TOKEN_PROGRAM_ID)) {
    return {
      ataBalance: 0n,
      allowance: 0n,
      eligible: false,
      reason: `agent ATA not owned by SPL Token (owner=${acct.owner.toBase58()})`,
      ata,
    };
  }
  const { mint, owner, amount, delegate, delegatedAmount } = readSplTokenAta(
    new Uint8Array(acct.data)
  );
  if (!mint.equals(usdcMint)) {
    return {
      ataBalance: amount,
      allowance: 0n,
      eligible: false,
      reason: `agent ATA mint mismatch (${mint.toBase58()})`,
      ata,
    };
  }
  if (!owner.equals(agentOwner)) {
    return {
      ataBalance: amount,
      allowance: 0n,
      eligible: false,
      reason: `agent ATA owner mismatch (${owner.toBase58()})`,
      ata,
    };
  }
  if (!delegate || !delegate.equals(settlementAuthorityPda)) {
    return {
      ataBalance: amount,
      allowance: 0n,
      eligible: false,
      reason: delegate
        ? `delegate is ${delegate.toBase58()}, expected ${settlementAuthorityPda.toBase58()}`
        : "no delegate set; agent must SPL-Approve SettlementAuthority",
      ata,
    };
  }
  if (delegatedAmount < requiredLamports) {
    return {
      ataBalance: amount,
      allowance: delegatedAmount,
      eligible: false,
      reason: `delegated_amount ${delegatedAmount} < requiredLamports ${requiredLamports}`,
      ata,
    };
  }
  if (amount < requiredLamports) {
    return {
      ataBalance: amount,
      allowance: delegatedAmount,
      eligible: false,
      reason: `ata balance ${amount} < requiredLamports ${requiredLamports}`,
      ata,
    };
  }
  return {
    ataBalance: amount,
    allowance: delegatedAmount,
    eligible: true,
    ata,
  };
}

// Standard SPL Associated Token Account program: PDA derived from
// [owner, TOKEN_PROGRAM_ID, mint] under program ID
// ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL. Matches
// @solana/spl-token@0.4.x's exported ASSOCIATED_TOKEN_PROGRAM_ID; inlined
// here to avoid a runtime dependency on @solana/spl-token.
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);

function deriveAssociatedTokenAccount(
  owner: PublicKey,
  mint: PublicKey
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return pda;
}

export { deriveAssociatedTokenAccount };
