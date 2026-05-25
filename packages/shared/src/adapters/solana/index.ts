/**
 * SolanaAdapter — passthrough wrapper over @q3labs/pact-protocol-v1-client
 * + @pact-network/wrap. Byte-identical behavior to direct calls (proven by
 * the parity test suite in Task 4).
 *
 * WP-MN-02: this adapter exists as a sidecar. No service imports it yet.
 * WP-MN-03b swaps `settler.submitter`, `indexer.on-chain-sync`, and
 * `market-proxy.balance` to consume it.
 */

import {
  buildSettleBatchIx,
  decodeCoveragePool,
  decodeTreasury,
  decodeEndpointConfig,
  ENDPOINT_CONFIG_LEN,
  FeeRecipientKind,
  getCoveragePoolPda,
  getCallRecordPda,
  getEndpointConfigPda,
  getProtocolConfigPda,
  getSettlementAuthorityPda,
  getTreasuryPda,
  PROGRAM_ID,
  slugBytes,
} from "@q3labs/pact-protocol-v1-client";
import {
  createDefaultBalanceCheck,
  type BalanceCheck,
} from "@pact-network/wrap";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type {
  ChainAdapter,
  ChainDescriptor,
  EligibilityCheckResult,
  EndpointConfigSnapshot,
  SettleBatchInput,
  SettleBatchResult,
} from "../../chain-adapter";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SolanaAdapterOptions {
  descriptor: ChainDescriptor;
  rpcUrl: string;
  programId?: PublicKey;
  fetchImpl?: typeof fetch;
  balanceCacheTtlMs?: number;
  connection?: Connection;
  balanceCheck?: BalanceCheck;
}

// ---------------------------------------------------------------------------
// SolanaAdapter
// ---------------------------------------------------------------------------

export class SolanaAdapter implements ChainAdapter {
  readonly descriptor: ChainDescriptor;
  private readonly connection: Connection;
  private readonly programId: PublicKey;
  private readonly balanceCheck: BalanceCheck;
  private readonly usdcMint: PublicKey;

  constructor(opts: SolanaAdapterOptions) {
    if (opts.descriptor.vm !== "solana") {
      throw new Error(
        `SolanaAdapter requires descriptor.vm === "solana", got "${opts.descriptor.vm}"`,
      );
    }
    this.descriptor = opts.descriptor;
    this.connection =
      opts.connection ?? new Connection(opts.rpcUrl, "confirmed");
    this.programId = opts.programId ?? PROGRAM_ID;
    this.usdcMint = new PublicKey(opts.descriptor.usdcMint);
    this.balanceCheck =
      opts.balanceCheck ??
      createDefaultBalanceCheck({
        rpcUrl: opts.rpcUrl,
        fetchImpl: opts.fetchImpl,
        cacheTtlMs: opts.balanceCacheTtlMs,
        resolveAta: (walletPubkey: string) => {
          const owner = new PublicKey(walletPubkey);
          return getAssociatedTokenAddressSync(
            this.usdcMint,
            owner,
          ).toBase58();
        },
      });
  }

  // -------------------------------------------------------------------------
  // readEndpointConfigs
  // Mirrors indexer/on-chain-sync.service.ts:~177: getProgramAccounts
  // filtered to ENDPOINT_CONFIG_LEN, then decodeEndpointConfig per account.
  // -------------------------------------------------------------------------
  async readEndpointConfigs(): Promise<ReadonlyArray<EndpointConfigSnapshot>> {
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      filters: [{ dataSize: ENDPOINT_CONFIG_LEN }],
    });
    const out: EndpointConfigSnapshot[] = [];
    for (const acct of accounts) {
      try {
        const decoded = decodeEndpointConfig(acct.account.data);
        // adapted from plan to match real EndpointConfig shape:
        // - "authority" lives on CoveragePool, not EndpointConfig; use coveragePool pubkey
        // - "maxTotalFeeBps" is not a field; use absolute BPS cap sentinel 0 (no contract)
        // - feeRecipients[i].destination is a string Pubkey alias (not PublicKey object)
        // - feeRecipients[i].kind is FeeRecipientKind enum (number)
        out.push({
          slug: Buffer.from(decoded.slug)
            .toString("utf-8")
            .replace(/\0+$/, ""),
          // EndpointConfig has no authority field — use coveragePool pubkey as proxy
          authority: decoded.coveragePool,
          // EndpointConfig has no maxTotalFeeBps — surface 0; adapter consumers
          // should read raw.percentBps / raw.feeRecipients for limits.
          maxTotalFeeBps: 0,
          feeRecipients: decoded.feeRecipients.map((r) => ({
            recipient: r.destination, // adapted: plan assumed "r.recipient", real field is "r.destination"
            bps: r.bps,
            kind: r.kind as number,
          })),
          paused: decoded.paused, // boolean — matches plan exactly
          raw: decoded,
        });
      } catch {
        // Skip undecodable accounts — parity with indexer's existing
        // behavior at on-chain-sync.service.ts:177.
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // submitSettleBatch
  // Mirrors settler/submitter/submitter.service.ts:buildSettleBatchIx call.
  //
  // The ChainAdapter.SettleBatchInput carries a slim per-event shape
  // (callId string, agent string, premiumBaseUnits, outcome, feeRecipientCountHint).
  // The real buildSettleBatchIx needs fully-resolved per-event PDAs. This
  // method performs the necessary on-chain reads (EndpointConfig, CoveragePool,
  // Treasury) to hydrate those PDAs — same pattern as settler.loadEndpoint().
  // -------------------------------------------------------------------------
  async submitSettleBatch(input: SettleBatchInput): Promise<SettleBatchResult> {
    const keypair = input.signer as Keypair;
    if (
      !keypair ||
      !(keypair as Keypair).publicKey ||
      !(keypair as Keypair).secretKey
    ) {
      throw new Error(
        "SolanaAdapter.submitSettleBatch requires signer: Keypair (must have publicKey + secretKey)",
      );
    }

    const slugBuf = slugBytes(input.slug);
    const [endpointConfigPda] = getEndpointConfigPda(this.programId, slugBuf);
    const [coveragePoolPda] = getCoveragePoolPda(this.programId, slugBuf);
    const [settlementAuthorityPda] = getSettlementAuthorityPda(this.programId);
    const [treasuryPda] = getTreasuryPda(this.programId);
    const [protocolConfigPda] = getProtocolConfigPda(this.programId);

    // Hydrate EndpointConfig + CoveragePool + Treasury in parallel.
    // adapted from plan: real buildSettleBatchIx needs per-event PDAs that
    // require on-chain reads; plan body assumed a simpler single-ix call.
    const [ecAcct, cpAcct, tsAcct] = await Promise.all([
      this.connection.getAccountInfo(endpointConfigPda, "confirmed"),
      this.connection.getAccountInfo(coveragePoolPda, "confirmed"),
      this.connection.getAccountInfo(treasuryPda, "confirmed"),
    ]);
    if (!ecAcct)
      throw new Error(
        `EndpointConfig PDA not found: ${endpointConfigPda.toBase58()}`,
      );
    if (!cpAcct)
      throw new Error(
        `CoveragePool PDA not found: ${coveragePoolPda.toBase58()}`,
      );
    if (!tsAcct)
      throw new Error(`Treasury PDA not found: ${treasuryPda.toBase58()}`);

    const endpointCfg = decodeEndpointConfig(ecAcct.data);
    const coveragePool = decodeCoveragePool(cpAcct.data);
    const treasury = decodeTreasury(tsAcct.data);

    const poolVault = new PublicKey(coveragePool.usdcVault);
    const treasuryVault = new PublicKey(treasury.usdcVault);

    // Resolve fee recipient ATAs in EndpointConfig order — mirrors
    // settler.submitter.service.ts:206-226.
    const feeRecipientAtasShared: PublicKey[] = [];
    for (let i = 0; i < endpointCfg.feeRecipientCount; i++) {
      const r = endpointCfg.feeRecipients[i];
      if (r.kind === FeeRecipientKind.Treasury) {
        feeRecipientAtasShared.push(treasuryVault);
      } else {
        feeRecipientAtasShared.push(new PublicKey(r.destination));
      }
    }

    // Build per-event SettlementEvent list + callRecordPdas.
    // adapted from plan: events carry slim fields; real buildSettleBatchIx
    // needs fully-resolved PublicKey PDAs per event.
    const callRecordPdas: PublicKey[] = [];
    const events: Parameters<typeof buildSettleBatchIx>[0]["events"] = [];

    for (const e of input.events) {
      const callIdBuf = Buffer.from(e.callId, "hex");
      const agentOwner = new PublicKey(e.agent);
      const agentAta = getAssociatedTokenAddressSync(this.usdcMint, agentOwner);

      callRecordPdas.push(
        getCallRecordPda(this.programId, callIdBuf)[0],
      );

      events.push({
        callId: callIdBuf,
        agentOwner,
        agentAta,
        endpointConfig: endpointConfigPda,
        coveragePool: coveragePoolPda,
        poolVault,
        slug: slugBuf,
        premiumLamports: e.premiumBaseUnits,
        // Exact refund from the wire (finding 6), not the premium — matches
        // settle_batch.rs, which pays `refund_lamports` verbatim, and restores
        // parity with the legacy-direct path. Defaults to 0 when unset.
        refundLamports: e.refundBaseUnits ?? 0n,
        latencyMs: e.latencyMs,
        breach: e.outcome === "breach",
        // Encode the canonical wrapped-call timestamp supplied by the settler
        // (Rick #226 F1), NOT submit-time Date.now() — restores parity with the
        // legacy-direct path. Falls back to the submit-time clock only when the
        // caller omits it.
        timestamp: e.eventTimestamp ?? BigInt(Math.floor(Date.now() / 1000)),
        feeRecipientAtas: feeRecipientAtasShared,
      });
    }

    // adapted from plan to match real SettleBatchParams shape:
    // no endpointConfigPda/coveragePoolPda/treasuryPda at top level;
    // all PDAs are per-event or in callRecordPdas.
    const ix = buildSettleBatchIx({
      programId: this.programId,
      settler: keypair.publicKey,
      settlementAuthority: settlementAuthorityPda,
      protocolConfig: protocolConfigPda,
      events,
      callRecordPdas,
    });

    const tx = new Transaction().add(ix);
    const sig = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [keypair],
      {
        commitment: input.options?.commitment ?? "confirmed",
        skipPreflight: input.options?.skipPreflight ?? false,
      },
    );

    return {
      txId: sig,
      perEvent: input.events.map((e) => ({
        callId: e.callId,
        status: "settled" as const,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // checkAgentEligibility
  // Wraps @pact-network/wrap's createDefaultBalanceCheck.
  // Mirrors market-proxy/lib/balance.ts behavior.
  // -------------------------------------------------------------------------
  async checkAgentEligibility(
    agent: string,
    requiredBaseUnits: bigint,
  ): Promise<EligibilityCheckResult> {
    const result = await this.balanceCheck.check(agent, requiredBaseUnits);
    if (result.eligible) {
      return {
        eligible: true,
        balance: result.ataBalance,
        allowance: result.allowance,
      };
    }
    return {
      eligible: false,
      // adapted from plan: BalanceCheckRejectionReason "no_ata" maps to
      // EligibilityRejectionReason "no_account" (different string literal).
      reason:
        result.reason === "no_ata"
          ? ("no_account" as const)
          : result.reason,
      balance: result.ataBalance,
      allowance: result.allowance,
    };
  }

  // tailSettlementEvents intentionally NOT implemented.
  // Pact Network uses PUSH model (settler → POST /events → indexer).
  // Per arch §3 L2 REV1: no symmetric watch/poll method on Solana adapter.
}
