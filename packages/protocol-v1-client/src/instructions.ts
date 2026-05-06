/**
 * Instruction builders for `pact-network-v1-pinocchio`.
 *
 * Every builder produces a `TransactionInstruction` whose:
 * - `programId` is the V1 program ID
 * - `keys` matches the account list documented at the top of the corresponding
 *   `src/instructions/<name>.rs` handler
 * - `data` starts with the discriminator byte from `src/discriminator.rs`
 *
 * The `buildApproveIx` / `buildRevokeIx` helpers wrap the standard SPL Token
 * `Approve` / `Revoke` instructions — they are NOT part of the V1 program
 * dispatcher. They exist here so consumers (agents and SDKs) have one import
 * path for "everything you need to operate against V1".
 */
import {
  AccountMeta,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

import {
  DISC_INITIALIZE_PROTOCOL_CONFIG,
  DISC_INITIALIZE_SETTLEMENT_AUTHORITY,
  DISC_INITIALIZE_TREASURY,
  DISC_PAUSE_ENDPOINT,
  DISC_PAUSE_PROTOCOL,
  DISC_REGISTER_ENDPOINT,
  DISC_SETTLE_BATCH,
  DISC_TOP_UP_COVERAGE_POOL,
  DISC_UPDATE_ENDPOINT_CONFIG,
  DISC_UPDATE_FEE_RECIPIENTS,
  PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./constants.js";
import { getProtocolConfigPda } from "./pda.js";
import {
  FeeRecipient,
  FeeRecipientKind,
  FEE_RECIPIENT_LEN,
} from "./state.js";

/**
 * Count the number of `kind == AffiliateAta` entries in a FeeRecipient array.
 * Used by builders to validate the caller-supplied AffiliateAta account list
 * before the program rejects the transaction with `InvalidAffiliateAta`.
 */
function countAffiliateAtas(entries: FeeRecipient[]): number {
  let n = 0;
  for (const e of entries) {
    if (e.kind === FeeRecipientKind.AffiliateAta) n++;
  }
  return n;
}

const SLUG_LEN = 16;
const CALL_ID_LEN = 16;

function asSlug(slug: Uint8Array): Uint8Array {
  if (slug.length === SLUG_LEN) return slug;
  if (slug.length > SLUG_LEN) {
    throw new Error(`slug must be <= ${SLUG_LEN} bytes`);
  }
  const out = new Uint8Array(SLUG_LEN);
  out.set(slug);
  return out;
}

function asCallId(callId: Uint8Array): Uint8Array {
  if (callId.length !== CALL_ID_LEN) {
    throw new Error(`call_id must be exactly ${CALL_ID_LEN} bytes`);
  }
  return callId;
}

/**
 * Encode a single FeeRecipient entry into 48 bytes — same layout as
 * `state.rs::FeeRecipient`.
 */
function encodeFeeRecipient(
  entry: FeeRecipient,
  out: Uint8Array,
  offset: number
): void {
  out[offset] = entry.kind;
  // _pad0 (offset+1..+8) zero (already zero-init)
  const dest = new PublicKey(entry.destination).toBytes();
  out.set(dest, offset + 8);
  new DataView(out.buffer, out.byteOffset).setUint16(offset + 40, entry.bps, true);
  // _pad1 (offset+42..+48) zero
}

function encodeFeeRecipientArray(entries: FeeRecipient[]): Uint8Array {
  const out = new Uint8Array(entries.length * FEE_RECIPIENT_LEN);
  for (let i = 0; i < entries.length; i++) {
    encodeFeeRecipient(entries[i], out, i * FEE_RECIPIENT_LEN);
  }
  return out;
}

// ---------------------------------------------------------------------------
// initialize_protocol_config (disc 12)
// ---------------------------------------------------------------------------

export interface InitializeProtocolConfigParams {
  programId?: PublicKey;
  /** Signer + payer, becomes ProtocolConfig.authority. */
  authority: PublicKey;
  /** ProtocolConfig PDA — derive via `getProtocolConfigPda`. */
  protocolConfig: PublicKey;
  /** USDC mint (must be USDC_MINT_DEVNET or USDC_MINT_MAINNET). */
  usdcMint: PublicKey;
  /**
   * Optional override for `max_total_fee_bps`. If undefined the program uses
   * `DEFAULT_MAX_TOTAL_FEE_BPS = 3000` (30%).
   */
  maxTotalFeeBps?: number;
  /** Default fee_recipients (0..=8 entries). */
  defaultFeeRecipients: FeeRecipient[];
}

/**
 * Builds the `initialize_protocol_config` instruction.
 *
 * Accounts (must match `src/instructions/initialize_protocol_config.rs`):
 *   0. authority         signer, writable
 *   1. protocol_config   writable PDA [b"protocol_config"]
 *   2. usdc_mint         readonly
 *   3. system_program
 *
 * Data: [disc=12][present:u8][max_total_fee_bps:u16][count:u8][entries...].
 */
export function buildInitializeProtocolConfigIx(
  p: InitializeProtocolConfigParams
): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  const present = p.maxTotalFeeBps !== undefined ? 1 : 0;
  const maxBps = p.maxTotalFeeBps ?? 0;
  const count = p.defaultFeeRecipients.length;
  const body = encodeFeeRecipientArray(p.defaultFeeRecipients);

  // 1 disc + 1 present + 2 max + 1 count + body
  const data = Buffer.alloc(1 + 1 + 2 + 1 + body.length);
  data[0] = DISC_INITIALIZE_PROTOCOL_CONFIG;
  data[1] = present;
  data.writeUInt16LE(maxBps, 2);
  data[4] = count;
  Buffer.from(body).copy(data, 5);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: p.authority, isSigner: true, isWritable: true },
      { pubkey: p.protocolConfig, isSigner: false, isWritable: true },
      { pubkey: p.usdcMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// initialize_treasury (disc 13)
// ---------------------------------------------------------------------------

export interface InitializeTreasuryParams {
  programId?: PublicKey;
  /** Must equal ProtocolConfig.authority. */
  authority: PublicKey;
  /** Existing ProtocolConfig PDA. */
  protocolConfig: PublicKey;
  /** Treasury PDA (derive via `getTreasuryPda`). */
  treasury: PublicKey;
  /**
   * Pre-allocated 165-byte token account (owned by SPL Token program). This is
   * a fresh keypair the caller funds with rent + space; the program's
   * `InitializeAccount3` CPI binds it to mint + treasury PDA.
   */
  treasuryVault: PublicKey;
  /** USDC mint. */
  usdcMint: PublicKey;
}

/**
 * Builds the `initialize_treasury` instruction.
 *
 * Accounts (per `src/instructions/initialize_treasury.rs`):
 *   0. authority         signer, writable
 *   1. protocol_config   readonly
 *   2. treasury          writable PDA [b"treasury"]
 *   3. treasury_vault    writable, pre-allocated token account
 *   4. usdc_mint         readonly
 *   5. system_program
 *   6. token_program
 *
 * Data: single byte = DISC_INITIALIZE_TREASURY.
 */
export function buildInitializeTreasuryIx(
  p: InitializeTreasuryParams
): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: p.authority, isSigner: true, isWritable: true },
      { pubkey: p.protocolConfig, isSigner: false, isWritable: false },
      { pubkey: p.treasury, isSigner: false, isWritable: true },
      { pubkey: p.treasuryVault, isSigner: false, isWritable: true },
      { pubkey: p.usdcMint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([DISC_INITIALIZE_TREASURY]),
  });
}

// ---------------------------------------------------------------------------
// initialize_settlement_authority (disc 1)
// ---------------------------------------------------------------------------

export interface InitializeSettlementAuthorityParams {
  programId?: PublicKey;
  /** Must equal ProtocolConfig.authority. */
  authority: PublicKey;
  protocolConfig: PublicKey;
  /** SettlementAuthority PDA. */
  settlementAuthority: PublicKey;
  /** Off-chain wallet allowed to sign settle_batch transactions. */
  settlerSigner: PublicKey;
}

/**
 * Builds the `initialize_settlement_authority` instruction.
 *
 * Accounts (per `src/instructions/initialize_settlement_authority.rs`):
 *   0. authority             signer, writable
 *   1. protocol_config       readonly
 *   2. settlement_authority  writable PDA
 *   3. system_program
 *
 * Data: [disc=1][settler_signer:32].
 */
export function buildInitializeSettlementAuthorityIx(
  p: InitializeSettlementAuthorityParams
): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  const data = Buffer.alloc(1 + 32);
  data[0] = DISC_INITIALIZE_SETTLEMENT_AUTHORITY;
  Buffer.from(p.settlerSigner.toBytes()).copy(data, 1);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: p.authority, isSigner: true, isWritable: true },
      { pubkey: p.protocolConfig, isSigner: false, isWritable: false },
      { pubkey: p.settlementAuthority, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// register_endpoint (disc 2)
// ---------------------------------------------------------------------------

export interface RegisterEndpointParams {
  programId?: PublicKey;
  /** Must equal ProtocolConfig.authority. */
  authority: PublicKey;
  protocolConfig: PublicKey;
  treasury: PublicKey;
  /** EndpointConfig PDA. */
  endpointConfig: PublicKey;
  /** CoveragePool PDA. */
  coveragePool: PublicKey;
  /** Pre-allocated 165-byte SPL Token account (owner = TOKEN_PROGRAM). */
  poolVault: PublicKey;
  usdcMint: PublicKey;
  /** 16-byte slug. */
  slug: Uint8Array;
  flatPremiumLamports: bigint;
  percentBps: number;
  slaLatencyMs: number;
  imputedCostLamports: bigint;
  exposureCapPerHourLamports: bigint;
  /**
   * Optional override for fee recipients. When `undefined`, the program copies
   * `ProtocolConfig.default_fee_recipients`. When set, must include
   * `feeRecipientCount` matching the array length.
   */
  feeRecipients?: FeeRecipient[];
  feeRecipientCount?: number;
  /**
   * Per-AffiliateAta token-account addresses, in the same order they appear
   * in `feeRecipients`. The program (codex 2026-05-05 fix) validates each is
   * an initialised SPL Token account on the protocol USDC mint with a
   * matching destination address. Must be provided whenever the (effective)
   * fee_recipients array contains at least one `AffiliateAta` entry; the
   * builder validates `affiliateAtas.length` matches the count of
   * AffiliateAta entries in `feeRecipients`.
   *
   * Note: when `feeRecipients` is omitted (defaults are used), the builder
   * cannot know how many AffiliateAtas to expect — the caller MUST supply
   * `affiliateAtas` matching whatever AffiliateAta entries live in the
   * on-chain `ProtocolConfig.default_fee_recipients`. The builder appends
   * whatever is passed; the program enforces the count on-chain.
   */
  affiliateAtas?: PublicKey[];
}

/**
 * Builds the `register_endpoint` instruction. Atomically allocates the
 * EndpointConfig PDA AND the slug-keyed CoveragePool PDA + pool USDC vault.
 *
 * Accounts (per `src/instructions/register_endpoint.rs`):
 *   0. authority         signer, writable
 *   1. protocol_config   readonly
 *   2. treasury          readonly
 *   3. endpoint_config   writable PDA [b"endpoint", slug]
 *   4. coverage_pool     writable PDA [b"coverage_pool", slug]
 *   5. pool_vault        writable, pre-allocated token account
 *   6. usdc_mint         readonly
 *   7. system_program
 *   8. token_program
 *   9..9+M. affiliate_ata_0..affiliate_ata_M-1 — readonly, one per
 *           AffiliateAta entry in the effective fee_recipients array, in the
 *           order they appear. (codex 2026-05-05 review fix.)
 */
export function buildRegisterEndpointIx(
  p: RegisterEndpointParams
): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  const slug = asSlug(p.slug);

  if (
    (p.feeRecipients === undefined) !==
    (p.feeRecipientCount === undefined)
  ) {
    throw new Error(
      "feeRecipients and feeRecipientCount must be provided together (or both omitted)"
    );
  }
  if (
    p.feeRecipients !== undefined &&
    p.feeRecipientCount !== p.feeRecipients.length
  ) {
    throw new Error(
      `feeRecipientCount (${p.feeRecipientCount}) must equal feeRecipients.length (${p.feeRecipients.length})`
    );
  }

  const present = p.feeRecipients ? 1 : 0;
  const count = p.feeRecipients?.length ?? 0;
  const body = p.feeRecipients
    ? encodeFeeRecipientArray(p.feeRecipients)
    : new Uint8Array(0);

  // When the caller supplies an explicit fee_recipients array, validate
  // affiliateAtas count matches the AffiliateAta entry count. We don't have
  // the on-chain defaults visible from the builder, so when feeRecipients
  // is omitted we trust whatever affiliateAtas the caller passes; the
  // program enforces the count on-chain (codex 2026-05-05 review fix).
  const affiliateAtas = p.affiliateAtas ?? [];
  if (p.feeRecipients !== undefined) {
    const expected = countAffiliateAtas(p.feeRecipients);
    if (affiliateAtas.length !== expected) {
      throw new Error(
        `affiliateAtas.length (${affiliateAtas.length}) must equal the number of AffiliateAta entries in feeRecipients (${expected})`
      );
    }
  }

  // [disc:1][slug:16][flatPremium:8][percentBps:2][slaMs:4]
  // [imputedCost:8][exposureCap:8][present:1][count:1][entries...]
  const data = Buffer.alloc(1 + 46 + 1 + 1 + body.length);
  data[0] = DISC_REGISTER_ENDPOINT;
  Buffer.from(slug).copy(data, 1);
  data.writeBigUInt64LE(p.flatPremiumLamports, 1 + 16);
  data.writeUInt16LE(p.percentBps, 1 + 24);
  data.writeUInt32LE(p.slaLatencyMs, 1 + 26);
  data.writeBigUInt64LE(p.imputedCostLamports, 1 + 30);
  data.writeBigUInt64LE(p.exposureCapPerHourLamports, 1 + 38);
  data[1 + 46] = present;
  data[1 + 47] = count;
  Buffer.from(body).copy(data, 1 + 48);

  const keys: AccountMeta[] = [
    { pubkey: p.authority, isSigner: true, isWritable: true },
    { pubkey: p.protocolConfig, isSigner: false, isWritable: false },
    { pubkey: p.treasury, isSigner: false, isWritable: false },
    { pubkey: p.endpointConfig, isSigner: false, isWritable: true },
    { pubkey: p.coveragePool, isSigner: false, isWritable: true },
    { pubkey: p.poolVault, isSigner: false, isWritable: true },
    { pubkey: p.usdcMint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  for (const ata of affiliateAtas) {
    keys.push({ pubkey: ata, isSigner: false, isWritable: false });
  }
  return new TransactionInstruction({ programId, keys, data });
}

// ---------------------------------------------------------------------------
// update_endpoint_config (disc 3)
// ---------------------------------------------------------------------------

export interface UpdateEndpointConfigParams {
  programId?: PublicKey;
  /** Must equal ProtocolConfig.authority. */
  authority: PublicKey;
  protocolConfig: PublicKey;
  endpointConfig: PublicKey;
  flatPremiumLamports?: bigint;
  percentBps?: number;
  slaLatencyMs?: number;
  imputedCostLamports?: bigint;
  exposureCapPerHourLamports?: bigint;
}

/**
 * Builds the `update_endpoint_config` instruction. Each optional field is
 * encoded as `[present:u8][value...]`. When `present == 0` the value bytes
 * are still written (zeroes) but ignored on-chain.
 *
 * Accounts:
 *   0. authority         signer
 *   1. protocol_config   readonly
 *   2. endpoint_config   writable
 *
 * Data: [disc=3][35-byte body, see src/instructions/update_endpoint_config.rs]
 */
export function buildUpdateEndpointConfigIx(
  p: UpdateEndpointConfigParams
): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  const body = Buffer.alloc(35);
  let off = 0;

  if (p.flatPremiumLamports !== undefined) {
    body[off] = 1;
    body.writeBigUInt64LE(p.flatPremiumLamports, off + 1);
  }
  off += 9;

  if (p.percentBps !== undefined) {
    body[off] = 1;
    body.writeUInt16LE(p.percentBps, off + 1);
  }
  off += 3;

  if (p.slaLatencyMs !== undefined) {
    body[off] = 1;
    body.writeUInt32LE(p.slaLatencyMs, off + 1);
  }
  off += 5;

  if (p.imputedCostLamports !== undefined) {
    body[off] = 1;
    body.writeBigUInt64LE(p.imputedCostLamports, off + 1);
  }
  off += 9;

  if (p.exposureCapPerHourLamports !== undefined) {
    body[off] = 1;
    body.writeBigUInt64LE(p.exposureCapPerHourLamports, off + 1);
  }
  // off += 9 (terminal)

  const data = Buffer.alloc(1 + 35);
  data[0] = DISC_UPDATE_ENDPOINT_CONFIG;
  body.copy(data, 1);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: p.authority, isSigner: true, isWritable: false },
      { pubkey: p.protocolConfig, isSigner: false, isWritable: false },
      { pubkey: p.endpointConfig, isSigner: false, isWritable: true },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// pause_endpoint (disc 4)
// ---------------------------------------------------------------------------

export interface PauseEndpointParams {
  programId?: PublicKey;
  authority: PublicKey;
  protocolConfig: PublicKey;
  endpointConfig: PublicKey;
  paused: boolean;
}

/**
 * Builds the `pause_endpoint` instruction.
 *
 * Accounts:
 *   0. authority         signer
 *   1. protocol_config   readonly
 *   2. endpoint_config   writable
 *
 * Data: [disc=4][paused:u8].
 */
export function buildPauseEndpointIx(
  p: PauseEndpointParams
): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: p.authority, isSigner: true, isWritable: false },
      { pubkey: p.protocolConfig, isSigner: false, isWritable: false },
      { pubkey: p.endpointConfig, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([DISC_PAUSE_ENDPOINT, p.paused ? 1 : 0]),
  });
}

// ---------------------------------------------------------------------------
// pause_protocol (disc 15) — global kill switch
// ---------------------------------------------------------------------------

export interface BuildPauseProtocolOpts {
  /** Override for the V1 program ID. Defaults to `PROGRAM_ID`. */
  programId?: PublicKey;
  /** ProtocolConfig.authority — the only key allowed to flip the flag. */
  authority: PublicKey;
  /**
   * Desired paused state. `true` / non-zero number = pause, `false` / `0` = unpause.
   * The on-chain handler stores the byte verbatim; any non-zero value engages the
   * kill switch. Operators should always send `0` or `1`.
   */
  paused: boolean | number;
}

/**
 * Builds the `pause_protocol` instruction (mainnet kill switch).
 *
 * When `paused != 0`, every subsequent `settle_batch` returns
 * `PactError::ProtocolPaused (6032)` before any per-event work — the entire
 * settlement pipeline halts until this same instruction is called again with
 * `paused = 0`.
 *
 * Accounts (per `src/instructions/pause_protocol.rs`):
 *   0. authority         signer; must equal ProtocolConfig.authority
 *   1. protocol_config   writable; canonical [b"protocol_config"] PDA
 *
 * Data: [disc=15][paused:u8] (2 bytes total).
 */
export function buildPauseProtocolIx(
  opts: BuildPauseProtocolOpts
): TransactionInstruction {
  const programId = opts.programId ?? PROGRAM_ID;
  const pausedByte =
    typeof opts.paused === "boolean"
      ? opts.paused
        ? 1
        : 0
      : opts.paused & 0xff;
  const [protocolConfig] = getProtocolConfigPda(programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: opts.authority, isSigner: true, isWritable: false },
      { pubkey: protocolConfig, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([DISC_PAUSE_PROTOCOL, pausedByte]),
  });
}

// ---------------------------------------------------------------------------
// top_up_coverage_pool (disc 9)
// ---------------------------------------------------------------------------

export interface TopUpCoveragePoolParams {
  programId?: PublicKey;
  /** Must equal CoveragePool.authority (the pool authority, NOT the protocol). */
  authority: PublicKey;
  /** Slug-derived CoveragePool PDA. */
  coveragePool: PublicKey;
  authorityAta: PublicKey;
  poolVault: PublicKey;
  /** 16-byte slug — must match the slug seeding `coveragePool`. */
  slug: Uint8Array;
  amount: bigint;
}

/**
 * Builds the `top_up_coverage_pool` instruction.
 *
 * Accounts:
 *   0. authority       signer
 *   1. coverage_pool   writable PDA
 *   2. authority_ata   writable (source)
 *   3. pool_vault      writable (destination)
 *   4. token_program
 *
 * Data: [disc=9][slug:16][amount:u64].
 */
export function buildTopUpCoveragePoolIx(
  p: TopUpCoveragePoolParams
): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  const slug = asSlug(p.slug);
  const data = Buffer.alloc(1 + 16 + 8);
  data[0] = DISC_TOP_UP_COVERAGE_POOL;
  Buffer.from(slug).copy(data, 1);
  data.writeBigUInt64LE(p.amount, 17);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: p.authority, isSigner: true, isWritable: false },
      { pubkey: p.coveragePool, isSigner: false, isWritable: true },
      { pubkey: p.authorityAta, isSigner: false, isWritable: true },
      { pubkey: p.poolVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// update_fee_recipients (disc 14)
// ---------------------------------------------------------------------------

export interface UpdateFeeRecipientsParams {
  programId?: PublicKey;
  authority: PublicKey;
  protocolConfig: PublicKey;
  treasury: PublicKey;
  endpointConfig: PublicKey;
  slug: Uint8Array;
  feeRecipients: FeeRecipient[];
  /** Must equal `feeRecipients.length` — kept explicit to mirror on-chain wire. */
  feeRecipientCount: number;
  /**
   * Per-AffiliateAta token-account addresses, in the same order they appear
   * in `feeRecipients`. The program (codex 2026-05-05 fix) validates each is
   * an initialised SPL Token account on the protocol USDC mint with a
   * matching destination. The builder validates `affiliateAtas.length`
   * matches the number of `AffiliateAta` entries in `feeRecipients`.
   */
  affiliateAtas?: PublicKey[];
}

/**
 * Builds the `update_fee_recipients` instruction.
 *
 * Accounts (per `src/instructions/update_fee_recipients.rs`):
 *   0. authority         signer
 *   1. protocol_config   readonly
 *   2. treasury          readonly
 *   3. endpoint_config   writable
 *   4..4+M. affiliate_ata_0..affiliate_ata_M-1 — readonly, one per
 *           AffiliateAta entry in the new fee_recipients array, in order.
 *           (codex 2026-05-05 review fix.)
 *
 * Data: [disc=14][slug:16][count:u8][entries...].
 */
export function buildUpdateFeeRecipientsIx(
  p: UpdateFeeRecipientsParams
): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  if (p.feeRecipientCount !== p.feeRecipients.length) {
    throw new Error(
      `feeRecipientCount (${p.feeRecipientCount}) must equal feeRecipients.length (${p.feeRecipients.length})`
    );
  }
  const affiliateAtas = p.affiliateAtas ?? [];
  const expectedAtas = countAffiliateAtas(p.feeRecipients);
  if (affiliateAtas.length !== expectedAtas) {
    throw new Error(
      `affiliateAtas.length (${affiliateAtas.length}) must equal the number of AffiliateAta entries in feeRecipients (${expectedAtas})`
    );
  }
  const slug = asSlug(p.slug);
  const body = encodeFeeRecipientArray(p.feeRecipients);
  const data = Buffer.alloc(1 + 16 + 1 + body.length);
  data[0] = DISC_UPDATE_FEE_RECIPIENTS;
  Buffer.from(slug).copy(data, 1);
  data[17] = p.feeRecipientCount;
  Buffer.from(body).copy(data, 18);

  const keys: AccountMeta[] = [
    { pubkey: p.authority, isSigner: true, isWritable: false },
    { pubkey: p.protocolConfig, isSigner: false, isWritable: false },
    { pubkey: p.treasury, isSigner: false, isWritable: false },
    { pubkey: p.endpointConfig, isSigner: false, isWritable: true },
  ];
  for (const ata of affiliateAtas) {
    keys.push({ pubkey: ata, isSigner: false, isWritable: false });
  }
  return new TransactionInstruction({ programId, keys, data });
}

// ---------------------------------------------------------------------------
// settle_batch (disc 10)
// ---------------------------------------------------------------------------

/**
 * One settlement event (the input to settle_batch). The `feeRecipientAtas`
 * field MUST be in the same order as the EndpointConfig's `fee_recipients`
 * array — the program checks order.
 *
 * `agentAta` is the agent's USDC ATA. The agent must have SPL-Token-Approved
 * the SettlementAuthority PDA as a delegate with `delegated_amount >= premium`
 * BEFORE this batch is sent.
 */
export interface SettlementEvent {
  callId: Uint8Array; // 16 bytes
  agentOwner: PublicKey;
  agentAta: PublicKey;
  endpointConfig: PublicKey;
  coveragePool: PublicKey;
  poolVault: PublicKey;
  slug: Uint8Array; // 16 bytes
  premiumLamports: bigint;
  refundLamports: bigint;
  latencyMs: number;
  breach: boolean;
  /** Unix seconds. Must be <= cluster clock at settle time. */
  timestamp: number | bigint;
  /** Ordered ATAs matching EndpointConfig.fee_recipients[0..count]. */
  feeRecipientAtas: PublicKey[];
}

export interface SettleBatchParams {
  programId?: PublicKey;
  /** Must equal SettlementAuthority.signer. */
  settler: PublicKey;
  settlementAuthority: PublicKey;
  /**
   * Canonical ProtocolConfig PDA (`[b"protocol_config"]`). Sits at fixed
   * account index 4 — the on-chain handler reads `paused` here before any
   * per-event work runs and rejects the entire batch with
   * `PactError::ProtocolPaused (6032)` if the kill switch is engaged. Pre-derive
   * via `getProtocolConfigPda(programId)`; supplying any other key fails the
   * `verify_protocol_config` PDA check.
   */
  protocolConfig: PublicKey;
  events: SettlementEvent[];
  /**
   * Per-event CallRecord PDAs. If omitted, the builder will require the caller
   * to set this elsewhere — typically derived via `getCallRecordPda(call_id)`.
   */
  callRecordPdas: PublicKey[];
}

/** Bytes per encoded settle_batch event. CANONICAL — see `settle_batch.rs`. */
export const SETTLE_EVENT_BYTES = 104;

/**
 * Builds the `settle_batch` instruction.
 *
 * Account layout (must match `src/instructions/settle_batch.rs`):
 *   Fixed prefix (5):
 *     0. settler_signer
 *     1. settlement_authority PDA
 *     2. token_program
 *     3. system_program
 *     4. protocol_config PDA — readonly canonical [b"protocol_config"];
 *        on-chain handler reads `paused` here and rejects the entire batch
 *        with `PactError::ProtocolPaused (6032)` before any per-event work.
 *        (Mainnet kill-switch addition, 2026-05-06.)
 *   Per event (5 + N where N = endpoint.fee_recipient_count):
 *     0. call_record PDA
 *     1. coverage_pool PDA
 *     2. coverage_pool USDC vault
 *     3. endpoint_config PDA
 *     4. agent USDC ATA
 *     5..5+N. fee recipient ATAs (in EndpointConfig order)
 *
 * Wire data (after the disc byte):
 *   0..2:   event_count u16 LE
 *   per event (104 bytes):
 *     0..16:    call_id [u8;16]
 *     16..48:   agent_owner Pubkey
 *     48..64:   slug [u8;16]
 *     64..72:   premium_lamports u64
 *     72..80:   refund_lamports u64
 *     80..84:   latency_ms u32
 *     84:       breach u8
 *     85:       fee_recipient_count_hint u8
 *     86..92:   _pad
 *     92..100:  timestamp i64
 *     100..104: _pad2
 */
export function buildSettleBatchIx(
  p: SettleBatchParams
): TransactionInstruction {
  const programId = p.programId ?? PROGRAM_ID;
  const events = p.events;
  if (events.length !== p.callRecordPdas.length) {
    throw new Error(
      `callRecordPdas length (${p.callRecordPdas.length}) must equal events length (${events.length})`
    );
  }

  const data = Buffer.alloc(1 + 2 + events.length * SETTLE_EVENT_BYTES);
  data[0] = DISC_SETTLE_BATCH;
  data.writeUInt16LE(events.length, 1);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const off = 3 + i * SETTLE_EVENT_BYTES;
    Buffer.from(asCallId(ev.callId)).copy(data, off);
    Buffer.from(ev.agentOwner.toBytes()).copy(data, off + 16);
    Buffer.from(asSlug(ev.slug)).copy(data, off + 48);
    data.writeBigUInt64LE(ev.premiumLamports, off + 64);
    data.writeBigUInt64LE(ev.refundLamports, off + 72);
    data.writeUInt32LE(ev.latencyMs, off + 80);
    data[off + 84] = ev.breach ? 1 : 0;
    data[off + 85] = ev.feeRecipientAtas.length;
    // _pad 86..92
    const ts = typeof ev.timestamp === "bigint" ? ev.timestamp : BigInt(ev.timestamp);
    data.writeBigInt64LE(ts, off + 92);
    // _pad2 100..104
  }

  const keys: AccountMeta[] = [
    { pubkey: p.settler, isSigner: true, isWritable: true },
    { pubkey: p.settlementAuthority, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: p.protocolConfig, isSigner: false, isWritable: false },
  ];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    keys.push({ pubkey: p.callRecordPdas[i], isSigner: false, isWritable: true });
    keys.push({ pubkey: ev.coveragePool, isSigner: false, isWritable: true });
    keys.push({ pubkey: ev.poolVault, isSigner: false, isWritable: true });
    keys.push({ pubkey: ev.endpointConfig, isSigner: false, isWritable: true });
    keys.push({ pubkey: ev.agentAta, isSigner: false, isWritable: true });
    for (const fa of ev.feeRecipientAtas) {
      keys.push({ pubkey: fa, isSigner: false, isWritable: true });
    }
  }

  return new TransactionInstruction({ programId, keys, data });
}

// ---------------------------------------------------------------------------
// SPL Token Approve / Revoke wrappers
//
// These are NOT V1 program instructions. They invoke the SPL Token program
// directly so an agent can pre-authorize the SettlementAuthority PDA to pull
// premiums from their ATA. Bundled here so consumers have one import.
// ---------------------------------------------------------------------------

const SPL_TOKEN_INSTR_APPROVE = 4;
const SPL_TOKEN_INSTR_REVOKE = 5;

export interface ApproveParams {
  /** The agent's USDC ATA whose delegate is being set. */
  agentAta: PublicKey;
  /** The SettlementAuthority PDA that will be the delegate. */
  settlementAuthorityPda: PublicKey;
  /** Maximum number of token base units the delegate may transfer. */
  allowanceLamports: bigint;
  /** The agent's wallet (signer). */
  agentOwner: PublicKey;
}

/**
 * Wraps SPL Token `Approve`. The agent must sign the resulting transaction.
 *
 * Accounts (per SPL Token spec):
 *   0. source       writable (agent ATA)
 *   1. delegate     readonly (SettlementAuthority PDA)
 *   2. owner        signer (agent)
 */
export function buildApproveIx(p: ApproveParams): TransactionInstruction {
  const data = Buffer.alloc(1 + 8);
  data[0] = SPL_TOKEN_INSTR_APPROVE;
  data.writeBigUInt64LE(p.allowanceLamports, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: p.agentAta, isSigner: false, isWritable: true },
      { pubkey: p.settlementAuthorityPda, isSigner: false, isWritable: false },
      { pubkey: p.agentOwner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export interface RevokeParams {
  agentAta: PublicKey;
  agentOwner: PublicKey;
}

/**
 * Wraps SPL Token `Revoke`.
 *
 * Accounts:
 *   0. source   writable
 *   1. owner    signer
 */
export function buildRevokeIx(p: RevokeParams): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: p.agentAta, isSigner: false, isWritable: true },
      { pubkey: p.agentOwner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([SPL_TOKEN_INSTR_REVOKE]),
  });
}
