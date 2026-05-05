// State account layouts — byte offsets match the on-chain #[repr(C)] structs

// CoveragePool: 1+7+32+32+32+8+8+8+8+8 = 144 bytes
export interface CoveragePool {
  bump: number;
  authority: Uint8Array;   // [32]
  usdcMint: Uint8Array;    // [32]
  usdcVault: Uint8Array;   // [32]
  totalDeposits: bigint;
  totalPremiums: bigint;
  totalRefunds: bigint;
  currentBalance: bigint;
  createdAt: bigint;
}

export function decodeCoveragePool(data: Uint8Array): CoveragePool {
  const v = new DataView(data.buffer, data.byteOffset);
  return {
    bump: data[0],
    authority: data.slice(8, 40),
    usdcMint: data.slice(40, 72),
    usdcVault: data.slice(72, 104),
    totalDeposits: v.getBigUint64(104, true),
    totalPremiums: v.getBigUint64(112, true),
    totalRefunds: v.getBigUint64(120, true),
    currentBalance: v.getBigUint64(128, true),
    createdAt: v.getBigInt64(136, true),
  };
}

// EndpointConfig: 1+1+6+16+8+2+6+4+4+8+8+8+8+8+8+8+8+8 = 120 bytes
export interface EndpointConfig {
  bump: number;
  paused: boolean;
  slug: Uint8Array;             // [16]
  flatPremiumLamports: bigint;
  percentBps: number;
  slaLatencyMs: number;
  imputedCostLamports: bigint;
  exposureCapPerHourLamports: bigint;
  currentPeriodStart: bigint;
  currentPeriodRefunds: bigint;
  totalCalls: bigint;
  totalBreaches: bigint;
  totalPremiums: bigint;
  totalRefunds: bigint;
  lastUpdated: bigint;
}

export function decodeEndpointConfig(data: Uint8Array): EndpointConfig {
  const v = new DataView(data.buffer, data.byteOffset);
  return {
    bump: data[0],
    paused: data[1] !== 0,
    slug: data.slice(8, 24),
    flatPremiumLamports: v.getBigUint64(24, true),
    percentBps: v.getUint16(32, true),
    slaLatencyMs: v.getUint32(40, true),
    imputedCostLamports: v.getBigUint64(48, true),
    exposureCapPerHourLamports: v.getBigUint64(56, true),
    currentPeriodStart: v.getBigInt64(64, true),
    currentPeriodRefunds: v.getBigUint64(72, true),
    totalCalls: v.getBigUint64(80, true),
    totalBreaches: v.getBigUint64(88, true),
    totalPremiums: v.getBigUint64(96, true),
    totalRefunds: v.getBigUint64(104, true),
    lastUpdated: v.getBigInt64(112, true),
  };
}

// AgentWallet: 1+7+32+32+8+8+8+8+8+8+8+8+8 = 144 bytes
export interface AgentWallet {
  bump: number;
  owner: Uint8Array;             // [32]
  usdcVault: Uint8Array;         // [32]
  balance: bigint;
  totalDeposits: bigint;
  totalPremiumsPaid: bigint;
  totalRefundsReceived: bigint;
  totalRefundsClaimed: bigint;
  callCount: bigint;
  pendingWithdrawal: bigint;
  withdrawalUnlockAt: bigint;
  createdAt: bigint;
}

export function decodeAgentWallet(data: Uint8Array): AgentWallet {
  const v = new DataView(data.buffer, data.byteOffset);
  return {
    bump: data[0],
    owner: data.slice(8, 40),
    usdcVault: data.slice(40, 72),
    balance: v.getBigUint64(72, true),
    totalDeposits: v.getBigUint64(80, true),
    totalPremiumsPaid: v.getBigUint64(88, true),
    totalRefundsReceived: v.getBigUint64(96, true),
    totalRefundsClaimed: v.getBigUint64(104, true),
    callCount: v.getBigUint64(112, true),
    pendingWithdrawal: v.getBigUint64(120, true),
    withdrawalUnlockAt: v.getBigInt64(128, true),
    createdAt: v.getBigInt64(136, true),
  };
}

// SettlementAuthority: 1+7+32+8 = 48 bytes
export interface SettlementAuthority {
  bump: number;
  signer: Uint8Array;  // [32]
  setAt: bigint;
}

export function decodeSettlementAuthority(data: Uint8Array): SettlementAuthority {
  const v = new DataView(data.buffer, data.byteOffset);
  return {
    bump: data[0],
    signer: data.slice(8, 40),
    setAt: v.getBigInt64(40, true),
  };
}
