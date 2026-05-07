import {
  address,
  appendTransactionMessageInstruction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  fixEncoderSize,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
  type ProgramDerivedAddress,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  type Signature,
} from '@solana/kit';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { getApproveInstruction } from '@solana-program/token';
import {
  decodeProtocolConfig,
  decodeCoveragePool,
  decodePolicy,
  getPolicyAgentId,
  getEnableInsuranceInstruction,
  COVERAGE_POOL_SEED,
  POLICY_SEED,
  PROTOCOL_CONFIG_SEED,
} from './generated/index.js';
import type {
  EnableInsuranceArgs as GeneratedEnableInsuranceArgs,
} from './generated/types/enableInsuranceArgs.js';
import type { PolicyInfo, EnableInsuranceArgs, TopUpDelegationArgs, CoverageEstimate } from './types.js';

export interface KitClientOptions {
  rpcUrl: string;
  programId: string;
  agentKeypair: Keypair;
}

export interface KitClient {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  signer: KeyPairSigner;
  programId: Address;
  agentKeypair: Keypair;
}

export async function createKitClient(opts: KitClientOptions): Promise<KitClient> {
  const rpcUrl = opts.rpcUrl;
  const wsUrl = rpcUrl.replace(/^https?/, (m) => (m === 'https' ? 'wss' : 'ws'));
  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
  const signer = await createKeyPairSignerFromBytes(opts.agentKeypair.secretKey);
  return {
    rpc,
    rpcSubscriptions,
    signer,
    programId: address(opts.programId),
    agentKeypair: opts.agentKeypair,
  };
}

async function sendTx(
  client: KitClient,
  instructions: Instruction[],
): Promise<string> {
  const { value: latestBlockhash } = await client.rpc.getLatestBlockhash().send();
  const base = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(client.signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
  );
  // Use reduce with `any` to avoid TS exploding on accumulating intersection types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg = instructions.reduce<any>(
    (m, ix) => appendTransactionMessageInstruction(ix, m),
    base,
  );
  const signed = await signTransactionMessageWithSigners(msg);
  const wire = getBase64EncodedWireTransaction(signed);
  const sig = await client.rpc
    .sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' })
    .send();
  await waitForConfirmation(client, sig);
  return sig as string;
}

async function waitForConfirmation(client: KitClient, signature: Signature): Promise<void> {
  const maxAttempts = 60;
  for (let i = 0; i < maxAttempts; i++) {
    const result = await client.rpc
      .getSignatureStatuses([signature], { searchTransactionHistory: false })
      .send();
    const status = result.value[0];
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      if (status.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Transaction ${signature} not confirmed after ${maxAttempts} attempts`);
}

function toAddress(pk: PublicKey): Address {
  return address(pk.toBase58());
}

function toPublicKey(addr: Address): PublicKey {
  return new PublicKey(addr as string);
}

// Override the hardcoded programAddress baked into Codama-generated
// instructions so the SDK honors the programId passed to PactInsurance.
// Without this, pointing the SDK at a different deploy via config silently
// sends to the wrong program.
function withProgramAddress<T extends { programAddress: Address }>(
  ix: T,
  programAddress: Address,
): T {
  return { ...ix, programAddress };
}

// Codama generated PDA helpers (findProtocolConfigPda / findCoveragePoolPda /
// findPolicyPda) hardcode PACT_INSURANCE_PROGRAM_ADDRESS as the programAddress
// arg to getProgramDerivedAddress. That makes the configurable programId on
// PactInsurance a half-truth: instructions get re-pointed via withProgramAddress
// above, but PDAs would still be derived against the baked-in default. The
// helpers below redo the derivation against client.programId so every account
// the SDK touches lives under the configured deploy.
async function deriveProtocolConfigPda(programId: Address): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [PROTOCOL_CONFIG_SEED],
  });
}

async function deriveCoveragePoolPda(programId: Address, hostname: string): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [COVERAGE_POOL_SEED, new TextEncoder().encode(hostname)],
  });
}

async function derivePolicyPda(programId: Address, pool: Address, agent: Address): Promise<ProgramDerivedAddress> {
  const addressEncoder = fixEncoderSize(getAddressEncoder(), 32);
  return getProgramDerivedAddress({
    programAddress: programId,
    seeds: [POLICY_SEED, addressEncoder.encode(pool), addressEncoder.encode(agent)],
  });
}

async function fetchBase64Account(
  rpc: Rpc<SolanaRpcApi>,
  addr: Address,
): Promise<Uint8Array | null> {
  const r = await rpc.getAccountInfo(addr, { encoding: 'base64' }).send();
  if (!r.value) return null;
  return new Uint8Array(Buffer.from(r.value.data[0] as string, 'base64'));
}

export async function kitEnableInsurance(
  client: KitClient,
  args: EnableInsuranceArgs,
): Promise<string> {
  const [protocolConfigAddr] = await deriveProtocolConfigPda(client.programId);
  const [poolAddr] = await deriveCoveragePoolPda(client.programId, args.providerHostname);
  const agentAddr = toAddress(client.agentKeypair.publicKey);
  const [policyAddr] = await derivePolicyPda(client.programId, poolAddr, agentAddr);

  const configBytes = await fetchBase64Account(client.rpc, protocolConfigAddr);
  if (!configBytes) throw new Error('Protocol config account not found');
  const config = decodeProtocolConfig(configBytes);

  const usdcMint = toPublicKey(config.usdcMint);
  const agentAta = getAssociatedTokenAddressSync(usdcMint, client.agentKeypair.publicKey);
  const agentAtaAddr = address(agentAta.toBase58());

  const approveIx = getApproveInstruction({
    source: agentAtaAddr,
    delegate: poolAddr,
    owner: client.signer,
    amount: args.allowanceUsdc,
  });

  const ZERO_REFERRER = new Uint8Array(32);
  const generatedArgs: GeneratedEnableInsuranceArgs = {
    agentId: args.agentId ?? client.agentKeypair.publicKey.toBase58().slice(0, 16),
    expiresAt: args.expiresAt ?? 0n,
    referrer: ZERO_REFERRER,
    referrerPresent: 0,
    referrerShareBps: 0,
  };

  const enableIx = withProgramAddress(
    getEnableInsuranceInstruction({
      config: protocolConfigAddr,
      pool: poolAddr,
      policy: policyAddr,
      agentTokenAccount: agentAtaAddr,
      agent: client.signer,
      args: generatedArgs,
    }),
    client.programId,
  );

  return sendTx(client, [approveIx, enableIx]);
}

export async function kitTopUpDelegation(
  client: KitClient,
  args: TopUpDelegationArgs,
): Promise<string> {
  const [protocolConfigAddr] = await deriveProtocolConfigPda(client.programId);
  const [poolAddr] = await deriveCoveragePoolPda(client.programId, args.providerHostname);

  const configBytes = await fetchBase64Account(client.rpc, protocolConfigAddr);
  if (!configBytes) throw new Error('Protocol config account not found');
  const config = decodeProtocolConfig(configBytes);

  const usdcMint = toPublicKey(config.usdcMint);
  const agentAta = getAssociatedTokenAddressSync(usdcMint, client.agentKeypair.publicKey);
  const agentAtaAddr = address(agentAta.toBase58());

  const approveIx = getApproveInstruction({
    source: agentAtaAddr,
    delegate: poolAddr,
    owner: client.signer,
    amount: args.newTotalAllowanceUsdc,
  });

  return sendTx(client, [approveIx]);
}

export async function kitGetPolicy(
  client: KitClient,
  providerHostname: string,
): Promise<PolicyInfo | null> {
  const agentAddr = toAddress(client.agentKeypair.publicKey);
  const [poolAddr] = await deriveCoveragePoolPda(client.programId, providerHostname);
  const [policyAddr] = await derivePolicyPda(client.programId, poolAddr, agentAddr);

  const policyBytes = await fetchBase64Account(client.rpc, policyAddr);
  if (!policyBytes) return null;

  const policy = decodePolicy(policyBytes);
  const agentAtaPk = toPublicKey(policy.agentTokenAccount);

  let delegatedAmount = 0n;
  try {
    const taBytes = await fetchBase64Account(client.rpc, policy.agentTokenAccount);
    if (taBytes) {
      const ta = await getAccount({ getAccountInfo: async () => null } as any, agentAtaPk);
      delegatedAmount = ta.delegatedAmount;
    }
  } catch {
    // best-effort
  }

  return {
    pool: toPublicKey(policy.pool),
    agent: toPublicKey(policy.agent),
    agentTokenAccount: agentAtaPk,
    agentId: getPolicyAgentId(policy),
    totalPremiumsPaid: policy.totalPremiumsPaid,
    totalClaimsReceived: policy.totalClaimsReceived,
    callsCovered: policy.callsCovered,
    active: policy.active !== 0,
    createdAt: policy.createdAt,
    expiresAt: policy.expiresAt,
    delegatedAmount,
    remainingAllowance: delegatedAmount,
  };
}

export async function kitListPolicies(
  client: KitClient,
): Promise<PolicyInfo[]> {
  const base58Key = client.agentKeypair.publicKey.toBase58();

  const accounts = await (client.rpc as any).getProgramAccounts(
    client.programId,
    {
      encoding: 'base64',
      filters: [
        { memcmp: { offset: 8, bytes: base58Key, encoding: 'base58' } },
      ],
    },
  ).send();

  const out: PolicyInfo[] = [];
  for (const acct of accounts as any[]) {
    const bytes = new Uint8Array(Buffer.from(acct.account.data[0], 'base64'));
    const policy = decodePolicy(bytes);
    const agentAtaPk = toPublicKey(policy.agentTokenAccount);

    let delegatedAmount = 0n;
    try {
      const ta = await getAccount({ getAccountInfo: async () => null } as any, agentAtaPk);
      delegatedAmount = ta.delegatedAmount;
    } catch {
      // best-effort
    }

    out.push({
      pool: toPublicKey(policy.pool),
      agent: toPublicKey(policy.agent),
      agentTokenAccount: agentAtaPk,
      agentId: getPolicyAgentId(policy),
      totalPremiumsPaid: policy.totalPremiumsPaid,
      totalClaimsReceived: policy.totalClaimsReceived,
      callsCovered: policy.callsCovered,
      active: policy.active !== 0,
      createdAt: policy.createdAt,
      expiresAt: policy.expiresAt,
      delegatedAmount,
      remainingAllowance: delegatedAmount,
    });
  }
  return out;
}

export async function kitEstimateCoverage(
  client: KitClient,
  providerHostname: string,
  usdcAmount: bigint,
): Promise<CoverageEstimate> {
  const [poolAddr] = await deriveCoveragePoolPda(client.programId, providerHostname);
  const poolBytes = await fetchBase64Account(client.rpc, poolAddr);
  if (!poolBytes) throw new Error(`Coverage pool not found for hostname: ${providerHostname}`);
  const pool = decodeCoveragePool(poolBytes);
  const rateBps = pool.insuranceRateBps;
  const perCallPremium = (usdcAmount * BigInt(rateBps)) / 10_000n;
  const estimatedCalls = perCallPremium > 0n ? Number(usdcAmount / perCallPremium) : 0;
  return { rateBps, estimatedCalls, perCallPremium };
}
