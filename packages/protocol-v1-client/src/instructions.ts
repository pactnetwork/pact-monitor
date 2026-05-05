import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { PROGRAM_ID } from "./constants.js";

const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

export function buildInitializeCoveragePool(
  authority: PublicKey,
  poolPda: PublicKey,
  vault: PublicKey,
  mint: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: poolPda, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([0]),
  });
}

export function buildInitializeSettlementAuthority(
  authority: PublicKey,
  poolPda: PublicKey,
  settlementAuthPda: PublicKey,
  settlerSigner: PublicKey
): TransactionInstruction {
  const data = Buffer.alloc(33);
  data[0] = 1;
  settlerSigner.toBuffer().copy(data, 1);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: poolPda, isSigner: false, isWritable: false },
      { pubkey: settlementAuthPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export interface RegisterEndpointArgs {
  slug: Uint8Array;
  flatPremiumLamports: bigint;
  percentBps: number;
  slaLatencyMs: number;
  imputedCostLamports: bigint;
  exposureCapPerHourLamports: bigint;
}

export function buildRegisterEndpoint(
  authority: PublicKey,
  poolPda: PublicKey,
  endpointPda: PublicKey,
  args: RegisterEndpointArgs
): TransactionInstruction {
  const data = Buffer.alloc(47);
  data[0] = 2;
  data.set(args.slug, 1);
  new DataView(data.buffer).setBigUint64(17, args.flatPremiumLamports, true);
  new DataView(data.buffer).setUint16(25, args.percentBps, true);
  new DataView(data.buffer).setUint32(27, args.slaLatencyMs, true);
  new DataView(data.buffer).setBigUint64(31, args.imputedCostLamports, true);
  new DataView(data.buffer).setBigUint64(39, args.exposureCapPerHourLamports, true);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: poolPda, isSigner: false, isWritable: false },
      { pubkey: endpointPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildInitializeAgentWallet(
  owner: PublicKey,
  walletPda: PublicKey,
  vault: PublicKey,
  mint: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: vault, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([5]),
  });
}

export function buildDepositUsdc(
  owner: PublicKey,
  walletPda: PublicKey,
  ownerAta: PublicKey,
  walletVault: PublicKey,
  amount: bigint
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = 6;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: ownerAta, isSigner: false, isWritable: true },
      { pubkey: walletVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildRequestWithdrawal(
  owner: PublicKey,
  walletPda: PublicKey,
  amount: bigint
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = 7;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: walletPda, isSigner: false, isWritable: true },
    ],
    data,
  });
}

export function buildExecuteWithdrawal(
  owner: PublicKey,
  walletPda: PublicKey,
  walletVault: PublicKey,
  ownerAta: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: walletVault, isSigner: false, isWritable: true },
      { pubkey: ownerAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([8]),
  });
}

export function buildClaimRefund(
  owner: PublicKey,
  walletPda: PublicKey,
  walletVault: PublicKey,
  ownerAta: PublicKey,
  amount: bigint
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data[0] = 11;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: walletPda, isSigner: false, isWritable: true },
      { pubkey: walletVault, isSigner: false, isWritable: true },
      { pubkey: ownerAta, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

export function buildPauseEndpoint(
  authority: PublicKey,
  poolPda: PublicKey,
  endpointPda: PublicKey,
  paused: boolean
): TransactionInstruction {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: poolPda, isSigner: false, isWritable: false },
      { pubkey: endpointPda, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([4, paused ? 1 : 0]),
  });
}

export interface SettlementEvent {
  callId: Uint8Array;
  agentOwner: PublicKey;
  agentWalletPda: PublicKey;
  agentVault: PublicKey;
  endpointPda: PublicKey;
  slug: Uint8Array;
  premiumLamports: bigint;
  refundLamports: bigint;
  latencyMs: number;
  breach: boolean;
  timestamp: number;
}

export function buildSettleBatch(
  settler: PublicKey,
  settlementAuthPda: PublicKey,
  poolPda: PublicKey,
  poolVault: PublicKey,
  events: SettlementEvent[],
  callRecordPdas: PublicKey[]
): TransactionInstruction {
  const BYTES_PER_EVENT = 100;
  const payload = Buffer.alloc(2 + events.length * BYTES_PER_EVENT);
  new DataView(payload.buffer).setUint16(0, events.length, true);

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const off = 2 + i * BYTES_PER_EVENT;
    payload.set(e.callId, off);
    payload.set(e.agentOwner.toBuffer(), off + 16);
    payload.set(e.slug, off + 48);
    new DataView(payload.buffer).setBigUint64(off + 64, e.premiumLamports, true);
    new DataView(payload.buffer).setBigUint64(off + 72, e.refundLamports, true);
    new DataView(payload.buffer).setUint32(off + 80, e.latencyMs, true);
    payload[off + 84] = e.breach ? 1 : 0;
    new DataView(payload.buffer).setBigInt64(off + 92, BigInt(e.timestamp), true);
  }

  const data = Buffer.alloc(1 + payload.length);
  data[0] = 10;
  payload.copy(data, 1);

  const keys = [
    { pubkey: settler, isSigner: true, isWritable: true },
    { pubkey: settlementAuthPda, isSigner: false, isWritable: false },
    { pubkey: poolPda, isSigner: false, isWritable: true },
    { pubkey: poolVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: PublicKey.default, isSigner: false, isWritable: false },
  ];

  for (let i = 0; i < events.length; i++) {
    keys.push({ pubkey: callRecordPdas[i], isSigner: false, isWritable: true });
    keys.push({ pubkey: events[i].agentWalletPda, isSigner: false, isWritable: true });
    keys.push({ pubkey: events[i].agentVault, isSigner: false, isWritable: true });
    keys.push({ pubkey: events[i].endpointPda, isSigner: false, isWritable: true });
  }

  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data });
}
