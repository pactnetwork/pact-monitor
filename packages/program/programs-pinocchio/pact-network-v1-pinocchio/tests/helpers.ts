import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { LiteSVM, ComputeBudget, Clock } from "litesvm";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as path from "path";
import { fileURLToPath } from "url";

export const PROGRAM_ID = new PublicKey("5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5");

// Devnet USDC mint — must equal USDC_DEVNET in src/constants.rs
export const USDC_MINT_PUBKEY = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

// Discriminator constants (from src/discriminator.rs, post-Step-C).
export const DISC_INIT_SETTLEMENT_AUTHORITY = 1;
export const DISC_REGISTER_ENDPOINT = 2;
export const DISC_UPDATE_ENDPOINT_CONFIG = 3;
export const DISC_PAUSE_ENDPOINT = 4;
export const DISC_TOP_UP_COVERAGE_POOL = 9;
export const DISC_SETTLE_BATCH = 10;
export const DISC_INIT_PROTOCOL_CONFIG = 12;
export const DISC_INIT_TREASURY = 13;
export const DISC_UPDATE_FEE_RECIPIENTS = 14;
export const DISC_PAUSE_PROTOCOL = 15;

// FeeRecipientKind (from state.rs)
export const FEE_KIND_TREASURY = 0;
export const FEE_KIND_AFFILIATE_ATA = 1;
export const FEE_KIND_AFFILIATE_PDA = 2;

const SO_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../target/deploy/pact_network_v1.so"
);

export function loadProgram(svm: LiteSVM, programId: PublicKey = PROGRAM_ID): void {
  const nowSecs = BigInt(Math.floor(Date.now() / 1000));
  svm.setClock(new Clock(0n, nowSecs, 0n, 1n, nowSecs));
  const budget = new ComputeBudget();
  budget.computeUnitLimit = 1_400_000n;
  svm.withComputeBudget(budget);
  svm.addProgramFromFile(programId, SO_PATH);
}

export function airdrop(svm: LiteSVM, pubkey: PublicKey, lamports: bigint = 10_000_000_000n): void {
  svm.setAccount(pubkey, {
    lamports,
    data: new Uint8Array(0),
    owner: SystemProgram.programId,
    executable: false,
  });
}

export function generateKeypair(svm: LiteSVM): Keypair {
  const kp = Keypair.generate();
  airdrop(svm, kp.publicKey);
  return kp;
}

// PDA derivation
export function deriveCoveragePool(slug: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("coverage_pool"), Buffer.from(slug)],
    PROGRAM_ID,
  );
}

export function deriveSettlementAuthority(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("settlement_authority")], PROGRAM_ID);
}

export function deriveEndpointConfig(slug: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("endpoint"), Buffer.from(slug)], PROGRAM_ID);
}

export function deriveCallRecord(callId: Uint8Array): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("call"), Buffer.from(callId)], PROGRAM_ID);
}

export function deriveTreasury(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("treasury")], PROGRAM_ID);
}

export function deriveProtocolConfig(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("protocol_config")], PROGRAM_ID);
}

export function slugBytes(slug: string): Uint8Array {
  const buf = new Uint8Array(16);
  const encoded = new TextEncoder().encode(slug.slice(0, 16));
  buf.set(encoded);
  return buf;
}

// Mint a test USDC-like token at the devnet USDC pubkey.
export function setupUsdcMint(svm: LiteSVM, mintAuthority: Keypair): PublicKey {
  const mintData = new Uint8Array(82);
  const view = new DataView(mintData.buffer);
  view.setUint32(0, 1, true); // COption::Some
  mintData.set(mintAuthority.publicKey.toBytes(), 4);
  mintData[44] = 6;  // decimals
  mintData[45] = 1;  // is_initialized

  svm.setAccount(USDC_MINT_PUBKEY, {
    lamports: 1_000_000_000n,
    data: mintData,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
  });

  return USDC_MINT_PUBKEY;
}

// Build a 165-byte SPL Token account buffer.
function makeTokenAccountData(mint: PublicKey, owner: PublicKey, amount: bigint = 0n): Uint8Array {
  const tokenData = new Uint8Array(165);
  // mint (0-31)
  tokenData.set(mint.toBytes(), 0);
  // owner (32-63)
  tokenData.set(owner.toBytes(), 32);
  // amount (64-71)
  new DataView(tokenData.buffer).setBigUint64(64, amount, true);
  // delegate option none (72-75 = 0)
  // state (108) = 1 (initialized)
  tokenData[108] = 1;
  return tokenData;
}

export function createTokenAccount(
  svm: LiteSVM,
  mint: PublicKey,
  owner: PublicKey,
): PublicKey {
  const tokenAcctKp = Keypair.generate();
  const tokenData = makeTokenAccountData(mint, owner);

  svm.setAccount(tokenAcctKp.publicKey, {
    lamports: 2_039_280n,
    data: tokenData,
    owner: TOKEN_PROGRAM_ID,
    executable: false,
  });

  return tokenAcctKp.publicKey;
}

// Pre-populate a pre-allocated 165-byte TOKEN-owned account at the given
// pubkey. Used for vaults that the program initializes via InitializeAccount3.
export function preallocateTokenAccount(svm: LiteSVM, pubkey: PublicKey): void {
  svm.setAccount(pubkey, {
    lamports: 2_039_280n,
    data: new Uint8Array(165),
    owner: TOKEN_PROGRAM_ID,
    executable: false,
  });
}

export function mintTokensToAccount(svm: LiteSVM, tokenAccount: PublicKey, amount: bigint): void {
  const acct = svm.getAccount(tokenAccount);
  if (!acct) throw new Error("token account not found");
  const data = new Uint8Array(acct.data);
  const view = new DataView(data.buffer);
  const current = view.getBigUint64(64, true);
  view.setBigUint64(64, current + amount, true);
  svm.setAccount(tokenAccount, { ...acct, data });
}

export function getTokenBalance(svm: LiteSVM, tokenAccount: PublicKey): bigint {
  const acct = svm.getAccount(tokenAccount);
  if (!acct) return 0n;
  return new DataView(acct.data.buffer).getBigUint64(64, true);
}

// Set the delegate + delegated_amount on an SPL Token account. Mimics what
// SPL Token `Approve` would write — used to bypass the Approve CPI in tests
// where we want to pre-bake a pre-approved agent ATA.
export function setTokenDelegate(
  svm: LiteSVM,
  tokenAccount: PublicKey,
  delegate: PublicKey,
  amount: bigint,
): void {
  const acct = svm.getAccount(tokenAccount);
  if (!acct) throw new Error("token account not found");
  const data = new Uint8Array(acct.data);
  // delegate option = Some at offset 72 (4 bytes), pubkey at 76-107 (32 bytes)
  new DataView(data.buffer).setUint32(72, 1, true); // COption::Some
  data.set(delegate.toBytes(), 76);
  // delegated_amount at offset 121 (8 bytes LE)
  new DataView(data.buffer).setBigUint64(121, amount, true);
  svm.setAccount(tokenAccount, { ...acct, data });
}

// Clear the delegate (mimics SPL Token `Revoke`).
export function clearTokenDelegate(svm: LiteSVM, tokenAccount: PublicKey): void {
  const acct = svm.getAccount(tokenAccount);
  if (!acct) throw new Error("token account not found");
  const data = new Uint8Array(acct.data);
  // delegate option = None
  new DataView(data.buffer).setUint32(72, 0, true);
  for (let i = 76; i < 108; i++) data[i] = 0;
  new DataView(data.buffer).setBigUint64(121, 0n, true);
  svm.setAccount(tokenAccount, { ...acct, data });
}

export function getTokenDelegate(svm: LiteSVM, tokenAccount: PublicKey): { delegate: PublicKey | null; amount: bigint } {
  const acct = svm.getAccount(tokenAccount);
  if (!acct) return { delegate: null, amount: 0n };
  const data = acct.data;
  const opt = new DataView(data.buffer).getUint32(72, true);
  if (opt === 0) return { delegate: null, amount: 0n };
  return {
    delegate: new PublicKey(data.slice(76, 108)),
    amount: new DataView(data.buffer).getBigUint64(121, true),
  };
}

export function getAccountData(svm: LiteSVM, pubkey: PublicKey): Uint8Array | null {
  const acct = svm.getAccount(pubkey);
  return acct ? new Uint8Array(acct.data) : null;
}

export function readU64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer).getBigUint64(offset, true);
}

export function readU16(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer).getUint16(offset, true);
}

export function readI64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer).getBigInt64(offset, true);
}

// ---------------------------------------------------------------------------
// Fee recipient encoding — must match the on-chain FeeRecipient layout (48 B).
// ---------------------------------------------------------------------------

export interface FeeRecipientEntry {
  kind: number;
  destination: PublicKey;
  bps: number;
}

export const FEE_RECIPIENT_LEN = 48;

export function encodeFeeRecipient(entry: FeeRecipientEntry, out: Uint8Array, offset: number): void {
  out[offset] = entry.kind;
  // _pad0 (offset+1..+8) zero
  out.set(entry.destination.toBytes(), offset + 8);
  new DataView(out.buffer).setUint16(offset + 40, entry.bps, true);
  // _pad1 (offset+42..+48) zero
}

export function encodeFeeRecipients(entries: FeeRecipientEntry[]): Uint8Array {
  const out = new Uint8Array(entries.length * FEE_RECIPIENT_LEN);
  for (let i = 0; i < entries.length; i++) {
    encodeFeeRecipient(entries[i], out, i * FEE_RECIPIENT_LEN);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Instruction builders
// ---------------------------------------------------------------------------

export function buildInitializeProtocolConfig(
  authority: PublicKey,
  pcPda: PublicKey,
  mint: PublicKey,
  args: {
    maxTotalFeeBpsPresent?: boolean;
    maxTotalFeeBps?: number;
    defaultRecipients: FeeRecipientEntry[];
  },
): TransactionInstruction {
  const present = args.maxTotalFeeBpsPresent ? 1 : 0;
  const max = args.maxTotalFeeBps ?? 0;
  const count = args.defaultRecipients.length;
  const headerLen = 1 + 1 + 2 + 1; // disc + present + max + count
  const body = encodeFeeRecipients(args.defaultRecipients);
  const data = Buffer.alloc(headerLen + body.length);
  data[0] = DISC_INIT_PROTOCOL_CONFIG;
  data[1] = present;
  new DataView(data.buffer).setUint16(2, max, true);
  data[4] = count;
  Buffer.from(body).copy(data, headerLen);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: pcPda, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildInitializeTreasury(
  authority: PublicKey,
  pcPda: PublicKey,
  treasuryPda: PublicKey,
  treasuryVault: PublicKey,
  mint: PublicKey,
  svm: LiteSVM,
): TransactionInstruction {
  preallocateTokenAccount(svm, treasuryVault);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: pcPda, isSigner: false, isWritable: false },
      { pubkey: treasuryPda, isSigner: false, isWritable: true },
      { pubkey: treasuryVault, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([DISC_INIT_TREASURY]),
  });
}

export function buildInitializeSettlementAuthority(
  authority: PublicKey,
  pcPda: PublicKey,
  saPda: PublicKey,
  settlerSigner: PublicKey,
): TransactionInstruction {
  const data = Buffer.alloc(33);
  data[0] = DISC_INIT_SETTLEMENT_AUTHORITY;
  settlerSigner.toBuffer().copy(data, 1);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: pcPda, isSigner: false, isWritable: false },
      { pubkey: saPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildRegisterEndpoint(args: {
  authority: PublicKey;
  pcPda: PublicKey;
  treasuryPda: PublicKey;
  endpointPda: PublicKey;
  poolPda: PublicKey;
  poolVault: PublicKey;
  mint: PublicKey;
  svm: LiteSVM;
  slug: Uint8Array;
  flatPremium: bigint;
  percentBps: number;
  slaMs: number;
  imputedCost: bigint;
  exposureCap: bigint;
  recipientsOverride?: FeeRecipientEntry[]; // when set, sent inline; otherwise defaults from PC
  /**
   * AffiliateAta accounts in the same order they appear in
   * `recipientsOverride` (or `recipientsOverride === undefined` falls back
   * to ProtocolConfig defaults — caller should pass the same ATA list as
   * was used to seed PC). Required by the codex 2026-05-05 review fix:
   * the program now validates each AffiliateAta is a real, initialised
   * SPL Token account on the protocol USDC mint.
   */
  affiliateAtas?: PublicKey[];
}): TransactionInstruction {
  preallocateTokenAccount(args.svm, args.poolVault);

  const headerLen = 1 + 46; // disc + 46 bytes header
  const present = args.recipientsOverride ? 1 : 0;
  const count = args.recipientsOverride ? args.recipientsOverride.length : 0;
  const body = args.recipientsOverride ? encodeFeeRecipients(args.recipientsOverride) : new Uint8Array(0);
  const data = Buffer.alloc(headerLen + 1 + 1 + body.length); // header + present + count + entries
  data[0] = DISC_REGISTER_ENDPOINT;
  data.set(args.slug, 1);
  new DataView(data.buffer).setBigUint64(17, args.flatPremium, true);
  new DataView(data.buffer).setUint16(25, args.percentBps, true);
  new DataView(data.buffer).setUint32(27, args.slaMs, true);
  new DataView(data.buffer).setBigUint64(31, args.imputedCost, true);
  new DataView(data.buffer).setBigUint64(39, args.exposureCap, true);
  data[47] = present;
  data[48] = count;
  Buffer.from(body).copy(data, 49);

  const keys = [
    { pubkey: args.authority, isSigner: true, isWritable: true },
    { pubkey: args.pcPda, isSigner: false, isWritable: false },
    { pubkey: args.treasuryPda, isSigner: false, isWritable: false },
    { pubkey: args.endpointPda, isSigner: false, isWritable: true },
    { pubkey: args.poolPda, isSigner: false, isWritable: true },
    { pubkey: args.poolVault, isSigner: false, isWritable: true },
    { pubkey: args.mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  for (const ata of args.affiliateAtas ?? []) {
    keys.push({ pubkey: ata, isSigner: false, isWritable: false });
  }

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data,
  });
}

export function buildUpdateFeeRecipients(args: {
  authority: PublicKey;
  pcPda: PublicKey;
  treasuryPda: PublicKey;
  endpointPda: PublicKey;
  slug: Uint8Array;
  recipients: FeeRecipientEntry[];
  /**
   * AffiliateAta accounts in the same order they appear in `recipients`,
   * for the codex 2026-05-05 review fix.
   */
  affiliateAtas?: PublicKey[];
}): TransactionInstruction {
  const body = encodeFeeRecipients(args.recipients);
  const data = Buffer.alloc(1 + 16 + 1 + body.length);
  data[0] = DISC_UPDATE_FEE_RECIPIENTS;
  data.set(args.slug, 1);
  data[17] = args.recipients.length;
  Buffer.from(body).copy(data, 18);
  const keys = [
    { pubkey: args.authority, isSigner: true, isWritable: false },
    { pubkey: args.pcPda, isSigner: false, isWritable: false },
    { pubkey: args.treasuryPda, isSigner: false, isWritable: false },
    { pubkey: args.endpointPda, isSigner: false, isWritable: true },
  ];
  for (const ata of args.affiliateAtas ?? []) {
    keys.push({ pubkey: ata, isSigner: false, isWritable: false });
  }
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data,
  });
}

export function buildPauseProtocol(args: {
  authority: PublicKey;
  pcPda: PublicKey;
  paused: number; // 0 = unpause, 1 = pause; arbitrary u8 accepted
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.pcPda, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([DISC_PAUSE_PROTOCOL, args.paused & 0xff]),
  });
}

export function buildPauseEndpoint(args: {
  authority: PublicKey;
  pcPda: PublicKey;
  endpointPda: PublicKey;
  paused: boolean;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.pcPda, isSigner: false, isWritable: false },
      { pubkey: args.endpointPda, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([DISC_PAUSE_ENDPOINT, args.paused ? 1 : 0]),
  });
}

export function buildUpdateEndpointConfig(args: {
  authority: PublicKey;
  pcPda: PublicKey;
  endpointPda: PublicKey;
  flatPremium?: bigint;
  percentBps?: number;
  slaMs?: number;
  imputedCost?: bigint;
  exposureCap?: bigint;
}): TransactionInstruction {
  const body = Buffer.alloc(35);
  let off = 0;
  if (args.flatPremium !== undefined) {
    body[off] = 1;
    new DataView(body.buffer).setBigUint64(off + 1, args.flatPremium, true);
  }
  off += 9;
  if (args.percentBps !== undefined) {
    body[off] = 1;
    new DataView(body.buffer).setUint16(off + 1, args.percentBps, true);
  }
  off += 3;
  if (args.slaMs !== undefined) {
    body[off] = 1;
    new DataView(body.buffer).setUint32(off + 1, args.slaMs, true);
  }
  off += 5;
  if (args.imputedCost !== undefined) {
    body[off] = 1;
    new DataView(body.buffer).setBigUint64(off + 1, args.imputedCost, true);
  }
  off += 9;
  if (args.exposureCap !== undefined) {
    body[off] = 1;
    new DataView(body.buffer).setBigUint64(off + 1, args.exposureCap, true);
  }
  const data = Buffer.alloc(1 + 35);
  data[0] = DISC_UPDATE_ENDPOINT_CONFIG;
  body.copy(data, 1);

  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.pcPda, isSigner: false, isWritable: false },
      { pubkey: args.endpointPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

export function buildTopUpCoveragePool(args: {
  authority: PublicKey;
  poolPda: PublicKey;
  authorityAta: PublicKey;
  poolVault: PublicKey;
  slug: Uint8Array;
  amount: bigint;
}): TransactionInstruction {
  const data = Buffer.alloc(1 + 16 + 8);
  data[0] = DISC_TOP_UP_COVERAGE_POOL;
  data.set(args.slug, 1);
  new DataView(data.buffer).setBigUint64(17, args.amount, true);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: args.authority, isSigner: true, isWritable: false },
      { pubkey: args.poolPda, isSigner: false, isWritable: true },
      { pubkey: args.authorityAta, isSigner: false, isWritable: true },
      { pubkey: args.poolVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// settle_batch event payload (104 bytes per event)
export interface SettleEvent {
  callId: Uint8Array;
  agentOwner: PublicKey;
  agentAta: PublicKey;
  endpointPda: PublicKey;
  poolPda: PublicKey;
  poolVault: PublicKey;
  slug: Uint8Array;
  premium: bigint;
  refund: bigint;
  latencyMs: number;
  breach: boolean;
  timestamp: number;
  feeRecipientAtas: PublicKey[]; // exactly endpoint.fee_recipient_count, in order
}

export const SETTLE_EVENT_BYTES = 104;

export function buildSettleBatch(
  settler: PublicKey,
  saPda: PublicKey,
  events: SettleEvent[],
  pcPda?: PublicKey,
): TransactionInstruction {
  // Default to the canonical ProtocolConfig PDA when caller doesn't supply
  // an explicit one — covers every existing happy-path test that was written
  // before the kill-switch landed.
  const protocolConfig = pcPda ?? deriveProtocolConfig()[0];
  const data = Buffer.alloc(1 + 2 + events.length * SETTLE_EVENT_BYTES);
  data[0] = DISC_SETTLE_BATCH;
  new DataView(data.buffer).setUint16(1, events.length, true);
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    const off = 3 + i * SETTLE_EVENT_BYTES;
    data.set(ev.callId, off);
    data.set(ev.agentOwner.toBuffer(), off + 16);
    data.set(ev.slug, off + 48);
    new DataView(data.buffer).setBigUint64(off + 64, ev.premium, true);
    new DataView(data.buffer).setBigUint64(off + 72, ev.refund, true);
    new DataView(data.buffer).setUint32(off + 80, ev.latencyMs, true);
    data[off + 84] = ev.breach ? 1 : 0;
    data[off + 85] = ev.feeRecipientAtas.length; // hint
    new DataView(data.buffer).setBigInt64(off + 92, BigInt(ev.timestamp), true);
  }

  const keys = [
    { pubkey: settler, isSigner: true, isWritable: true },
    { pubkey: saPda, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: protocolConfig, isSigner: false, isWritable: false },
  ];
  for (const ev of events) {
    const [crPda] = deriveCallRecord(ev.callId);
    keys.push({ pubkey: crPda, isSigner: false, isWritable: true });
    keys.push({ pubkey: ev.poolPda, isSigner: false, isWritable: true });
    keys.push({ pubkey: ev.poolVault, isSigner: false, isWritable: true });
    keys.push({ pubkey: ev.endpointPda, isSigner: false, isWritable: true });
    keys.push({ pubkey: ev.agentAta, isSigner: false, isWritable: true });
    for (const fa of ev.feeRecipientAtas) {
      keys.push({ pubkey: fa, isSigner: false, isWritable: true });
    }
  }

  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}

// ---------------------------------------------------------------------------
// Test setup helpers
// ---------------------------------------------------------------------------

export interface BasicSetup {
  svm: LiteSVM;
  authority: Keypair;
  mint: PublicKey;
  pcPda: PublicKey;
  treasuryPda: PublicKey;
  treasuryVault: PublicKey;
}

/**
 * Initialize ProtocolConfig + Treasury with a one-entry default Treasury
 * recipient at 1000bps, so subsequent register_endpoint calls without an
 * override get a sensible default fan-out of 10% to Treasury.
 */
export function setupProtocolAndTreasury(svm: LiteSVM): BasicSetup {
  loadProgram(svm);
  const authority = generateKeypair(svm);
  const mintAuth = generateKeypair(svm);
  const mint = setupUsdcMint(svm, mintAuth);

  const [pcPda] = deriveProtocolConfig();
  const [treasuryPda] = deriveTreasury();

  // Treasury vault keypair — used as the canonical destination for Treasury
  // kind recipients. We create the account ahead of time and reuse for
  // subsequent register_endpoint calls.
  const treasuryVaultKp = Keypair.generate();
  const treasuryVault = treasuryVaultKp.publicKey;

  // The Treasury recipient default uses the Treasury USDC vault as its
  // destination. The on-chain register_endpoint substitutes Treasury kind
  // entries with Treasury.usdc_vault, so the value here is informational
  // (any 32-byte placeholder works); we use treasuryVault for clarity.
  const initPcIx = buildInitializeProtocolConfig(authority.publicKey, pcPda, mint, {
    defaultRecipients: [
      { kind: FEE_KIND_TREASURY, destination: treasuryVault, bps: 1000 },
    ],
  });
  const initTreasuryIx = buildInitializeTreasury(
    authority.publicKey,
    pcPda,
    treasuryPda,
    treasuryVault,
    mint,
    svm,
  );

  const tx = new Transaction();
  tx.add(initPcIx);
  tx.add(initTreasuryIx);
  tx.recentBlockhash = svm.latestBlockhash();
  tx.feePayer = authority.publicKey;
  tx.sign(authority);
  const result = svm.sendTransaction(tx);
  if ("err" in result) {
    throw new Error(`setupProtocolAndTreasury failed: ${JSON.stringify(result)} logs: ${(result as any).meta?.logs}`);
  }

  return { svm, authority, mint, pcPda, treasuryPda, treasuryVault };
}

export interface EndpointSetup extends BasicSetup {
  slug: Uint8Array;
  endpointPda: PublicKey;
  poolPda: PublicKey;
  poolVault: PublicKey;
}

export function registerSimpleEndpoint(
  base: BasicSetup,
  slugStr: string,
  args: {
    flatPremium?: bigint;
    percentBps?: number;
    slaMs?: number;
    imputedCost?: bigint;
    exposureCap?: bigint;
    recipientsOverride?: FeeRecipientEntry[];
    affiliateAtas?: PublicKey[];
  } = {},
): EndpointSetup {
  const slug = slugBytes(slugStr);
  const [endpointPda] = deriveEndpointConfig(slug);
  const [poolPda] = deriveCoveragePool(slug);
  const poolVault = Keypair.generate().publicKey;

  const ix = buildRegisterEndpoint({
    authority: base.authority.publicKey,
    pcPda: base.pcPda,
    treasuryPda: base.treasuryPda,
    endpointPda,
    poolPda,
    poolVault,
    mint: base.mint,
    svm: base.svm,
    slug,
    flatPremium: args.flatPremium ?? 500n,
    percentBps: args.percentBps ?? 0,
    slaMs: args.slaMs ?? 5000,
    imputedCost: args.imputedCost ?? 1000n,
    exposureCap: args.exposureCap ?? 5_000_000n,
    recipientsOverride: args.recipientsOverride,
    affiliateAtas: args.affiliateAtas,
  });
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = base.authority.publicKey;
  tx.sign(base.authority);
  const result = base.svm.sendTransaction(tx);
  if ("err" in result) {
    throw new Error(`registerSimpleEndpoint(${slugStr}) failed: ${JSON.stringify(result)} logs: ${(result as any).meta?.logs}`);
  }
  return { ...base, slug, endpointPda, poolPda, poolVault };
}

export function setupSettlementAuthority(base: BasicSetup, settler: Keypair): PublicKey {
  const [saPda] = deriveSettlementAuthority();
  const ix = buildInitializeSettlementAuthority(
    base.authority.publicKey,
    base.pcPda,
    saPda,
    settler.publicKey,
  );
  const tx = new Transaction();
  tx.add(ix);
  tx.recentBlockhash = base.svm.latestBlockhash();
  tx.feePayer = base.authority.publicKey;
  tx.sign(base.authority);
  const result = base.svm.sendTransaction(tx);
  if ("err" in result) {
    throw new Error(`setupSettlementAuthority failed: ${JSON.stringify(result)} logs: ${(result as any).meta?.logs}`);
  }
  return saPda;
}

/**
 * Mint USDC into the pool's USDC vault and bump the pool's cached
 * `current_balance`. Test-only — production code uses top_up_coverage_pool.
 */
export function fundPoolDirect(svm: LiteSVM, poolPda: PublicKey, poolVault: PublicKey, amount: bigint): void {
  mintTokensToAccount(svm, poolVault, amount);
  const acct = svm.getAccount(poolPda)!;
  const data = new Uint8Array(acct.data);
  // current_balance lives at byte 144 in the new CoveragePool layout
  // (bump 1 + pad 7 + authority 32 + mint 32 + vault 32 + slug 16 +
  //  total_deposits 8 + total_premiums 8 + total_refunds 8 = 144).
  const view = new DataView(data.buffer);
  const cur = view.getBigUint64(144, true);
  view.setBigUint64(144, cur + amount, true);
  svm.setAccount(poolPda, { ...acct, data });
}

export { TOKEN_PROGRAM_ID, SystemProgram, SYSVAR_RENT_PUBKEY, Keypair, PublicKey, Transaction, TransactionInstruction };
