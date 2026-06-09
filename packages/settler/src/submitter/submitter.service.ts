/**
 * SubmitterService — turns a flushed batch of canonical SettlementEvents
 * (camelCase JSON published by @pact-network/wrap, see wrap/src/types.ts)
 * into a single `settle_batch` transaction signed by the settler's
 * SettlementAuthority keypair.
 *
 * Per Step D #62 of the Network/Market layering refactor (see
 * docs/superpowers/plans/2026-05-05-network-market-layering-and-v1-v2-rename.md
 * §3 + §4 + §5):
 *
 *   - Per-endpoint coverage pools: each batched event resolves its slug's
 *     CoveragePool PDA + USDC vault. The on-chain handler iterates events
 *     positionally; account-list slots repeat per-event with NO cross-event
 *     deduplication (the program de-references each event's accounts by
 *     fixed offset).
 *
 *   - Agent custody via SPL Token Approve: agent ATA is the source of the
 *     premium. SettlementAuthority PDA is the SPL Token delegate; the on-chain
 *     program signs the Token::Transfer via invoke_signed. Off-chain we just
 *     load the SettlementAuthority *signer* keypair (whose pubkey is stored on
 *     SettlementAuthority.signer) and provide it as the outer transaction
 *     signer; the SettlementAuthority *PDA* itself is never an off-chain
 *     signer.
 *
 *   - Fee fan-out: each EndpointConfig carries up to 8 FeeRecipient entries.
 *     The program copies premium_lamports * bps / 10_000 to each in EndpointConfig
 *     order. Settler must pass the fee recipient ATAs *in the same order* as
 *     EndpointConfig.fee_recipients[0..count]. We load the EndpointConfig once
 *     per slug and cache for 60s.
 *
 *   - Treasury: when an event references a Treasury fee recipient, the
 *     destination on-chain is the Treasury USDC vault. Treasury PDA is a
 *     singleton — derived once at boot. The vault is read off the Treasury
 *     account.
 *
 * Wire shape: 104 bytes per event, with `fee_recipient_count_hint` at offset
 * 85 (the on-chain handler bounds-checks the per-event slice). This is encoded
 * by `buildSettleBatchIx` from @q3labs/pact-protocol-v1-client — we don't
 * touch the byte-level layout here.
 */
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  buildSettleBatchIx,
  decodeCoveragePool,
  decodeEndpointConfig,
  decodeTreasury,
  deriveAssociatedTokenAccount,
  EndpointConfig,
  FeeRecipientKind,
  getCallRecordPda,
  getCoveragePoolPda,
  getEndpointConfigPda,
  getProtocolConfigPda,
  getSettlementAuthorityPda,
  getTreasuryPda,
  slugBytes,
  USDC_MINT_DEVNET,
  type SettlementEvent as ChainSettlementEvent,
} from "@q3labs/pact-protocol-v1-client";

import type {
  ChainAdapter,
  EndpointConfigSnapshot,
} from "@pact-network/shared";

import { SettleBatch } from "../batcher/batcher.service";
import { SecretLoaderService } from "../config/secret-loader.service";
import { AdaptersService } from "../adapters/adapters.service";
import { hasSolanaNetwork } from "../config/enabled-networks";

const ENDPOINT_CACHE_TTL_MS = 60_000;
const DEFAULT_PROGRAM_ID = "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5";

export class BatchSubmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchSubmitError";
  }
}

/**
 * Thrown by submit() when a batch targets a network this settler instance does
 * NOT serve (network ∉ PACT_ENABLED_NETWORKS). The pipeline catches this and
 * ACKs the messages (drop), rather than nacking (redeliver) or crashing. This
 * is what makes per-network settler isolation safe on a fan-out Pub/Sub
 * subscription: a base-mainnet-only settler receiving a solana-* event drops
 * it cleanly instead of poison-looping. The owning settler (subscribed to its
 * own subscription) still processes its copy.
 */
export class SkipBatchError extends Error {
  constructor(public readonly network: string) {
    super(`batch network "${network}" not in PACT_ENABLED_NETWORKS — ack-skip`);
    this.name = "SkipBatchError";
  }
}

/**
 * Per-event fee-recipient share computed off-chain to feed the indexer push
 * body. The on-chain math is `premium * bps / 10_000` rounded down (residual
 * stays in pool); we mirror that exactly here.
 */
export interface RecipientShare {
  kind: FeeRecipientKind;
  /** ATA / vault pubkey credited on-chain (never a logical owner). */
  pubkey: string;
  amountLamports: bigint;
}

export interface SettlementOutcome {
  signature: string;
  /** Per-message recipient share breakdown derived from EndpointConfig snapshots. */
  perEventShares: RecipientShare[][];
}

interface EndpointSnapshot {
  loadedAt: number;
  config: EndpointConfig;
  endpointConfigPda: PublicKey;
  coveragePool: PublicKey;
  poolVault: PublicKey;
}

/**
 * Solana RPC + program-PDA bundle. Built only when a Solana network is enabled
 * (multi-evm WP T5) so an EVM-only settler can boot without SOLANA_RPC_URL.
 */
interface SolanaContext {
  connection: Connection;
  programId: PublicKey;
  usdcMint: PublicKey;
  settlementAuthorityPda: PublicKey;
  treasuryPda: PublicKey;
  /**
   * Canonical [b"protocol_config"] PDA. Required as fixed account index 4 of
   * every `settle_batch` tx — the on-chain handler reads `paused` here and
   * rejects the entire batch with `PactError::ProtocolPaused (6032)` before any
   * per-event work runs (mainnet kill switch, 2026-05-06). The settler does NOT
   * read or decode the account — the program does its own load + verify; we just
   * supply the PDA so the program can deref its own data buffer.
   */
  protocolConfigPda: PublicKey;
}

@Injectable()
export class SubmitterService implements OnModuleInit {
  private readonly logger = new Logger(SubmitterService.name);
  /** True iff PACT_ENABLED_NETWORKS includes a solana-* network. */
  private readonly solanaEnabled: boolean;
  /**
   * Solana deps (RPC Connection + program PDAs). Built eagerly in the
   * constructor when a Solana network is enabled (so a missing SOLANA_RPC_URL
   * still fails fast at boot, exactly as before) and left null for an EVM-only
   * settler so it boots without any Solana config (multi-evm WP T5).
   */
  private solanaCtx: SolanaContext | null = null;
  private treasuryVault: PublicKey | null = null;
  private readonly endpointCache = new Map<string, EndpointSnapshot>();

  constructor(
    private readonly config: ConfigService,
    private readonly secrets: SecretLoaderService,
    private readonly adaptersService: AdaptersService,
  ) {
    this.solanaEnabled = hasSolanaNetwork(
      this.config.get<string>("PACT_ENABLED_NETWORKS"),
    );

    // Build the Solana deps eagerly when a Solana network is enabled so a
    // missing SOLANA_RPC_URL still fails fast at construction, exactly as
    // before. An EVM-only settler (no solana-* enabled) skips this and boots
    // without any Solana config (multi-evm WP T5).
    if (this.solanaEnabled) {
      this.solana();
    } else {
      this.logger.log(
        "[settler] no Solana network enabled — EVM-only boot; skipping Solana Connection/PDA init",
      );
    }
  }

  /**
   * Build (and memoise) the Solana RPC Connection + program PDAs. Throws if
   * SOLANA_RPC_URL is unset — only ever reached when a Solana network is enabled
   * (eagerly at construction, or lazily on a Solana submit/read path).
   */
  private solana(): SolanaContext {
    if (this.solanaCtx) return this.solanaCtx;
    const rpc = this.config.getOrThrow<string>("SOLANA_RPC_URL");
    const connection = new Connection(rpc, "confirmed");
    const programId = new PublicKey(
      this.config.get<string>("PROGRAM_ID") ?? DEFAULT_PROGRAM_ID,
    );
    // Default to devnet USDC; mainnet flow overrides via env (USDC_MINT).
    const usdcMint = new PublicKey(
      this.config.get<string>("USDC_MINT") ?? USDC_MINT_DEVNET.toBase58(),
    );
    const [settlementAuthorityPda] = getSettlementAuthorityPda(programId);
    const [treasuryPda] = getTreasuryPda(programId);
    const [protocolConfigPda] = getProtocolConfigPda(programId);
    this.solanaCtx = {
      connection,
      programId,
      usdcMint,
      settlementAuthorityPda,
      treasuryPda,
      protocolConfigPda,
    };
    return this.solanaCtx;
  }

  async onModuleInit(): Promise<void> {
    if (!this.solanaEnabled) {
      this.logger.log("[settler] EVM-only boot — skipping Treasury vault preload");
      return;
    }
    // Treasury vault is a singleton; load once at boot. If the Treasury account
    // hasn't been initialised yet (cold devnet) we tolerate it — the first
    // batch that needs Treasury will retry through the cache miss path.
    try {
      this.treasuryVault = await this.loadTreasuryVault();
      this.logger.log(
        `Treasury vault resolved: ${this.treasuryVault.toBase58()}`,
      );
    } catch (err) {
      this.logger.warn(
        `Treasury vault not resolvable at boot — will retry per-batch: ${
          (err as Error).message ?? err
        }`,
      );
    }
  }

  /**
   * Thin router: delegates to adapter path or legacy-direct path depending
   * on PACT_LEGACY_DIRECT_SOLANA env flag. The network is extracted from the
   * first message's `network` field (defaulting to "solana-devnet" so legacy
   * events emitted before WP-MN-03a T2 still route correctly).
   */
  async submit(batch: SettleBatch): Promise<SettlementOutcome> {
    const firstData = batch.messages[0]?.data as Record<string, unknown> | undefined;
    const network = typeof firstData?.["network"] === "string"
      ? firstData["network"]
      : "solana-devnet";

    if (this.adaptersService.legacyDirectSolana && network.startsWith("solana-")) {
      return this.submitLegacyDirect(batch);
    }
    // Per-network isolation: if this instance has no adapter for the batch's
    // network (network ∉ PACT_ENABLED_NETWORKS), ack-skip rather than crash.
    // Lets a single-network settler share a fan-out subscription safely.
    if (!this.adaptersService.hasAdapter(network)) {
      throw new SkipBatchError(network);
    }
    return this.submitViaAdapter(batch, network);
  }

  /**
   * Adapter path — routes the batch through the network's ChainAdapter.
   * Maps the settler's batch.messages shape into SettleBatchInput.events,
   * calls adapter.submitSettleBatch, then maps the result back to
   * SettlementOutcome (matching the legacy return shape exactly).
   *
   * Note: the adapter handles per-slug EndpointConfig/CoveragePool loading
   * internally. The legacy endpointCache is NOT used on this path.
   *
   * RESEARCH §5.2: we accept one duplicate EndpointConfig load here (the
   * adapter's submitSettleBatch does its own load internally). This keeps
   * the off-chain share computation byte-identical to the legacy path
   * without leaking internal adapter state.
   */
  private async submitViaAdapter(
    batch: SettleBatch,
    network: string,
  ): Promise<SettlementOutcome> {
    const adapter = this.adaptersService.getAdapter(network);
    // Signer routing per VM:
    //   - Solana: pass the Keypair via SettleBatchInput.signer (the legacy
    //     convention; SolanaAdapter expects it).
    //   - EVM: the WalletClient was injected into EvmAdapter at construction
    //     time (AdaptersService.loadEvmAccount → EvmAdapterOptions.signer in
    //     T4); the input.signer field is unused on the EVM path. Pass null.
    const vm = adapter.descriptor.vm;
    const signer = vm === "solana"
      ? this.adaptersService.getSigner(network)
      : null;

    // All messages in a batch share one (network, slug) — the batcher
    // partitions before flush. Extract slug from the first message.
    const firstData = batch.messages[0]?.data as Record<string, unknown>;
    const slug = this.extractSlug(firstData);

    // VM-aware fee-config load (finding 1). Solana reads EndpointConfig +
    // CoveragePool PDAs via loadEndpoint; EVM reads the endpoint via the
    // adapter's getEndpoint(). The EVM path NEVER touches Solana PDAs, so a
    // same-slug Solana endpoint cannot leak its fee metadata into an EVM tx.
    const feeConfig = await this.loadFeeConfig(adapter, vm, slug);

    const result = await adapter.submitSettleBatch({
      slug,
      signer,
      events: batch.messages.map((m) => {
        const d = m.data as Record<string, unknown>;
        const callId = formatAdapterCallId(vm, String(d["callId"] ?? ""));
        const outcome = String(d["outcome"] ?? "ok");
        return {
          callId,
          agent: String(d["agentPubkey"] ?? ""),
          premiumBaseUnits: BigInt(d["premiumLamports"] as string | number),
          outcome: breachFromOutcome(outcome) ? ("breach" as const) : ("ok" as const),
          // Thread the exact refund from the wire (finding 6). The adapters
          // previously encoded refund = premium on breach, which is wrong on
          // both counts vs. the on-chain handler (which pays the supplied
          // refund verbatim, not the premium).
          refundBaseUnits: BigInt(
            (d["refundLamports"] as string | number | undefined) ?? "0",
          ),
          feeRecipientCountHint: feeConfig.feeRecipientCount,
          latencyMs: Number(d["latencyMs"] ?? 0),
          // Thread the canonical wrapped-call timestamp (Rick #226 F1). Use the
          // SAME parser the legacy-direct path uses so the adapter path records
          // wrapped-call time, not settler-exec Date.now(). parseEventTimestamp
          // returns unix seconds; the adapter wire field is bigint.
          eventTimestamp: BigInt(parseEventTimestamp(d)),
        };
      }),
      options: { commitment: "confirmed", skipPreflight: false },
    });

    // Compute per-event fee-recipient shares for the indexer push, mirroring
    // on-chain fee math (floor(premium * bps / 10_000)) per VM.
    const perEventShares: RecipientShare[][] = [];
    for (const m of batch.messages) {
      const d = m.data as Record<string, unknown>;
      const premiumLamports = BigInt(d["premiumLamports"] as string | number);
      perEventShares.push(await feeConfig.computeShares(premiumLamports));
    }

    return {
      signature: result.txId,
      perEventShares,
    };
  }

  /**
   * Resolve the fee fan-out for a slug in a VM-aware way (finding 1):
   *   - Solana: load EndpointConfig + CoveragePool PDAs (cached) and compute
   *     shares via the existing Treasury-vault-aware helper. Unchanged.
   *   - EVM: read the endpoint via the adapter's getEndpoint() — never Solana
   *     PDAs — and compute shares from the EVM fee recipients directly.
   *
   * Returns the feeRecipientCount hint the on-chain handler bounds-checks
   * against, plus a per-event share computation closure.
   */
  private async loadFeeConfig(
    adapter: ChainAdapter,
    vm: string,
    slug: string,
  ): Promise<{
    feeRecipientCount: number;
    computeShares: (premiumBaseUnits: bigint) => Promise<RecipientShare[]>;
  }> {
    if (vm === "solana") {
      const snap = await this.loadEndpoint(slug);
      return {
        feeRecipientCount: snap.config.feeRecipientCount,
        computeShares: (premium) =>
          this.computeFeeSharesForEvent(premium, snap.config),
      };
    }
    if (!adapter.getEndpoint) {
      throw new Error(
        `adapter for slug "${slug}" (vm=${vm}) does not implement getEndpoint`,
      );
    }
    const cfg = await adapter.getEndpoint(slug);
    return {
      feeRecipientCount: cfg.feeRecipients.length,
      computeShares: (premium) =>
        Promise.resolve(this.computeEvmFeeShares(premium, cfg)),
    };
  }

  /**
   * EVM per-event fee-recipient shares. Mirrors on-chain math
   * floor(premium * bps / 10_000) per recipient. Unlike Solana, EVM has no
   * Treasury-vault indirection — the recipient address is the pay target.
   */
  private computeEvmFeeShares(
    premiumBaseUnits: bigint,
    cfg: EndpointConfigSnapshot,
  ): RecipientShare[] {
    return cfg.feeRecipients.map((r) => ({
      kind: r.kind as FeeRecipientKind,
      pubkey: r.recipient,
      amountLamports: (premiumBaseUnits * BigInt(r.bps)) / 10_000n,
    }));
  }

  /**
   * Compute off-chain fee-recipient share breakdown for a single event.
   * Mirrors on-chain math exactly: floor(premiumLamports * bps / 10_000).
   * Called by BOTH submitLegacyDirect and submitViaAdapter — the byte-
   * identical gate (WP-MN-03b T5) verifies both paths produce equal arrays.
   *
   * Treasury entries resolve to the Treasury USDC vault (singleton, loaded
   * via requireTreasuryVault). All other kinds use the stored destination
   * directly.
   */
  private async computeFeeSharesForEvent(
    premiumLamports: bigint,
    endpointConfig: EndpointConfig,
  ): Promise<RecipientShare[]> {
    const shares: RecipientShare[] = [];
    const feeRecipientCount = endpointConfig.feeRecipientCount;
    for (let i = 0; i < feeRecipientCount; i++) {
      const r = endpointConfig.feeRecipients[i];
      let dest: PublicKey;
      if (r.kind === FeeRecipientKind.Treasury) {
        dest = await this.requireTreasuryVault();
      } else {
        dest = new PublicKey(r.destination);
      }
      // Mirror on-chain math: floor(premium * bps / 10_000).
      const amount = (premiumLamports * BigInt(r.bps)) / 10_000n;
      shares.push({
        kind: r.kind,
        pubkey: dest.toBase58(),
        amountLamports: amount,
      });
    }
    return shares;
  }

  /**
   * Legacy direct path — the pre-WP-MN-03b code, extracted verbatim.
   * Active when PACT_LEGACY_DIRECT_SOLANA=true (the rollback safety net).
   */
  private async submitLegacyDirect(batch: SettleBatch): Promise<SettlementOutcome> {
    const {
      connection,
      programId,
      usdcMint,
      settlementAuthorityPda,
      protocolConfigPda,
    } = this.solana();
    const keypair = this.secrets.keypair;
    const settler = keypair.publicKey;

    // Load each unique slug's EndpointConfig (cached 60s) before building.
    const slugs = new Set<string>();
    for (const m of batch.messages) {
      slugs.add(this.extractSlug(m.data));
    }
    const snapshots = new Map<string, EndpointSnapshot>();
    for (const slug of slugs) {
      snapshots.set(slug, await this.loadEndpoint(slug));
    }

    // Build per-event SettlementEvent + share breakdown.
    const events: ChainSettlementEvent[] = [];
    const callRecordPdas: PublicKey[] = [];
    const perEventShares: RecipientShare[][] = [];

    for (const m of batch.messages) {
      const d = m.data as Record<string, unknown>;
      const slug = this.extractSlug(d);
      const snap = snapshots.get(slug)!;

      const callId = parseCallId(String(d["callId"] ?? ""));
      const agentOwner = new PublicKey(String(d["agentPubkey"] ?? ""));
      const agentAta = deriveAssociatedTokenAccount(agentOwner, usdcMint);
      const premiumLamports = BigInt(d["premiumLamports"] as string | number);
      const refundLamports = BigInt(
        (d["refundLamports"] as string | number | undefined) ?? "0",
      );
      const latencyMs = Number(d["latencyMs"] ?? 0);
      const outcomeStr = String(d["outcome"] ?? "ok");
      const breach = breachFromOutcome(outcomeStr);
      const ts = parseEventTimestamp(d);

      // Resolve per-recipient ATAs and compute share breakdown using the
      // shared helper (same computation as the adapter path — byte-identical).
      const shares = await this.computeFeeSharesForEvent(premiumLamports, snap.config);
      // Build feeRecipientAtas array from the computed shares (maintains
      // EndpointConfig order as required by the on-chain handler).
      const feeRecipientAtas: PublicKey[] = shares.map((s) => new PublicKey(s.pubkey));

      events.push({
        callId,
        agentOwner,
        agentAta,
        endpointConfig: snap.endpointConfigPda,
        coveragePool: snap.coveragePool,
        poolVault: snap.poolVault,
        slug: slugBytes(slug),
        premiumLamports,
        refundLamports,
        latencyMs,
        breach,
        timestamp: ts,
        feeRecipientAtas,
      });
      callRecordPdas.push(getCallRecordPda(programId, callId)[0]);
      perEventShares.push(shares);
    }

    const ix = buildSettleBatchIx({
      programId,
      settler,
      settlementAuthority: settlementAuthorityPda,
      // Mainnet kill switch (2026-05-06): ProtocolConfig sits at fixed
      // account index 4. The on-chain handler reads `paused` here and
      // rejects the entire batch (PactError::ProtocolPaused = 6032) before
      // any per-event work runs.
      protocolConfig: protocolConfigPda,
      events,
      callRecordPdas,
    });

    // Compute-budget instructions are mandatory for settle_batch. Each event
    // performs 1 SPL Token Transfer (premium-in) + 1-9 SPL Token Transfers
    // (fee fan-out + optional refund) + 1 CallRecord init. The default 200k
    // CU/tx limit is exceeded after ~3 events with 1 fee recipient. The
    // priority-fee floor keeps txs landing during devnet/mainnet congestion.
    //
    // Sized for the 3-event MAX_BATCH_SIZE cap with up to 8 fee recipients
    // each: ~3 × 5 ix × ~20k CU ≈ 300k headroom; left at 1_000_000 for
    // headroom against the previous 5-cap and tx-CU jitter. Tune downward
    // once we have measured CU per event from surfpool/devnet logs.
    const computeUnitLimitIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_000_000,
    });
    // 5_000 microlamports/CU = 5 lamports/CU. At 1M CU that's 5_000 lamports
    // priority fee per tx — negligible on devnet, modest on mainnet. Tune via
    // recent-fees RPC in V2.
    const computeUnitPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: 5_000,
    });

    const signature = await this.sendWithRetry(
      async () => {
        const tx = new Transaction()
          .add(computeUnitLimitIx)
          .add(computeUnitPriceIx)
          .add(ix);
        return sendAndConfirmTransaction(connection, tx, [keypair], {
          commitment: "confirmed",
        });
      },
      3,
      callRecordPdas,
    );

    return { signature, perEventShares };
  }

  /**
   * Invalidate cached EndpointConfig snapshots for every slug present in a
   * batch, plus reset the Treasury vault cache. Called after a permanent
   * submit failure — the failure may have been driven by stale on-chain state
   * (e.g. update_fee_recipients ran since cache load and the recipient ATAs
   * don't match what the program now expects). Forces the next batch to
   * re-fetch.
   */
  invalidateCacheForBatch(batch: SettleBatch): void {
    const slugs = new Set<string>();
    for (const m of batch.messages) {
      try {
        slugs.add(this.extractSlug(m.data));
      } catch {
        // malformed message — already filtered upstream; safe to skip here
      }
    }
    for (const slug of slugs) {
      this.endpointCache.delete(slug);
    }
    // Treasury vault is singleton; invalidating it forces a fresh fetch.
    this.treasuryVault = null;
    this.logger.warn(
      `Invalidated cache for ${slugs.size} slug(s) + Treasury vault after submit failure`,
    );
  }

  // --------------------------------------------------------------------------
  // EndpointConfig + Treasury caching
  // --------------------------------------------------------------------------

  private async loadEndpoint(slug: string): Promise<EndpointSnapshot> {
    const now = Date.now();
    const cached = this.endpointCache.get(slug);
    if (cached && now - cached.loadedAt < ENDPOINT_CACHE_TTL_MS) {
      return cached;
    }
    const { connection, programId } = this.solana();
    const slugBuf = slugBytes(slug);
    const [endpointConfigPda] = getEndpointConfigPda(programId, slugBuf);
    const [coveragePool] = getCoveragePoolPda(programId, slugBuf);

    const [epAcct, poolAcct] = await Promise.all([
      connection.getAccountInfo(endpointConfigPda, "confirmed"),
      connection.getAccountInfo(coveragePool, "confirmed"),
    ]);
    if (!epAcct) {
      throw new Error(`EndpointConfig for slug "${slug}" not found on-chain`);
    }
    if (!poolAcct) {
      throw new Error(`CoveragePool for slug "${slug}" not found on-chain`);
    }
    const config = decodeEndpointConfig(epAcct.data);
    const pool = decodeCoveragePool(poolAcct.data);
    const snapshot: EndpointSnapshot = {
      loadedAt: now,
      config,
      endpointConfigPda,
      coveragePool,
      poolVault: new PublicKey(pool.usdcVault),
    };
    this.endpointCache.set(slug, snapshot);
    return snapshot;
  }

  private async loadTreasuryVault(): Promise<PublicKey> {
    const { connection, treasuryPda } = this.solana();
    const acct = await connection.getAccountInfo(treasuryPda, "confirmed");
    if (!acct) {
      throw new Error(`Treasury PDA ${treasuryPda.toBase58()} not initialised`);
    }
    const t = decodeTreasury(acct.data);
    return new PublicKey(t.usdcVault);
  }

  private async requireTreasuryVault(): Promise<PublicKey> {
    if (this.treasuryVault) return this.treasuryVault;
    this.treasuryVault = await this.loadTreasuryVault();
    return this.treasuryVault;
  }

  /** Test-only — clear caches to force a re-fetch. */
  resetCachesForTest(): void {
    this.endpointCache.clear();
    this.treasuryVault = null;
  }

  private extractSlug(data: unknown): string {
    const slug = (data as Record<string, unknown>)["endpointSlug"];
    if (typeof slug !== "string" || slug.length === 0) {
      throw new Error("settlement event missing endpointSlug");
    }
    return slug;
  }

  /**
   * Submit a tx with retry. **Idempotency-aware**: between retry attempts,
   * preflight `getAccountInfo(callRecordPdas[0])` — if the CallRecord PDA
   * already exists, the previous attempt's tx must have landed even though
   * the RPC ack was lost. Look up the prior signature via
   * `getSignaturesForAddress(callRecordPdas[0])` and return it instead of
   * resubmitting (which would fail with `account already in use` and poison-
   * loop the batch on Pub/Sub redelivery).
   *
   * The check uses `callRecordPdas[0]` because settle_batch initialises ALL
   * CallRecord PDAs in a single tx — if one exists, all of them do, and the
   * tx-id is the same for all.
   */
  private async sendWithRetry(
    fn: () => Promise<string>,
    maxAttempts: number,
    callRecordPdas?: PublicKey[],
  ): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // On retry only (attempt > 1), check if the prior attempt actually
        // landed despite returning an error.
        if (attempt > 1 && callRecordPdas && callRecordPdas.length > 0) {
          const priorSig = await this.findExistingCallRecordSignature(
            callRecordPdas[0],
          );
          if (priorSig) {
            this.logger.log(
              `Idempotency: callRecord ${callRecordPdas[0].toBase58()} already on-chain from sig ${priorSig} — short-circuiting retry`,
            );
            return priorSig;
          }
        }
        return await fn();
      } catch (err) {
        lastErr = err;
        this.logger.warn(
          `submit attempt ${attempt}/${maxAttempts} failed: ${err}`,
        );
        if (attempt < maxAttempts) {
          await sleep(500 * 2 ** (attempt - 1));
        }
      }
    }
    // Final idempotency check before declaring permanent failure: maybe the
    // last attempt landed too.
    if (callRecordPdas && callRecordPdas.length > 0) {
      try {
        const priorSig = await this.findExistingCallRecordSignature(
          callRecordPdas[0],
        );
        if (priorSig) {
          this.logger.log(
            `Idempotency: callRecord on-chain after all attempts; returning sig ${priorSig}`,
          );
          return priorSig;
        }
      } catch (idemErr) {
        this.logger.warn(
          `Idempotency post-flight check failed: ${idemErr}`,
        );
      }
    }
    throw new BatchSubmitError(
      `All ${maxAttempts} submit attempts failed: ${lastErr}`,
    );
  }

  /**
   * Returns the most recent transaction signature that touched the given
   * CallRecord PDA, or null if the account doesn't exist on-chain yet.
   *
   * Uses `getSignaturesForAddress` with limit=1 — the PDA is created exactly
   * once (settle_batch's CallRecord init) so the most recent signature is
   * the canonical one. If the account doesn't exist, the API returns empty.
   */
  private async findExistingCallRecordSignature(
    callRecordPda: PublicKey,
  ): Promise<string | null> {
    const { connection } = this.solana();
    const acct = await connection.getAccountInfo(callRecordPda, "confirmed");
    if (!acct) return null;
    const sigs = await connection.getSignaturesForAddress(callRecordPda, {
      limit: 1,
    });
    return sigs[0]?.signature ?? null;
  }

  // For consumers that want direct access to derived constants (used by tests).
  // These are Solana-only — they build/return the Solana PDA bundle and throw
  // if called on an EVM-only settler (no SOLANA_RPC_URL).
  get derivedSettlementAuthorityPda(): PublicKey {
    return this.solana().settlementAuthorityPda;
  }

  get derivedTreasuryPda(): PublicKey {
    return this.solana().treasuryPda;
  }

  get derivedProtocolConfigPda(): PublicKey {
    return this.solana().protocolConfigPda;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Map a wrap-library {@link Outcome} string to the on-chain `breach` byte. The
 * on-chain contract treats any non-`ok` outcome as a breach for refund-eligibility
 * purposes — the actual classification (latency vs server vs network) is a
 * downstream metric on the indexer side. Refund amount itself is supplied in
 * the wire payload, not derived from the outcome here.
 */
function breachFromOutcome(outcome: string): boolean {
  return outcome !== "ok";
}

/**
 * Format a wire call id for the adapter path. Both VMs derive the canonical
 * 16-byte hex from the UUID/hex call id. The EVM calldata encoder
 * (`encodeSettleBatch` -> `asBytes16`) requires a `0x`-prefixed bytes16, while
 * the Solana adapter consumes raw hex (`Buffer.from(callId, "hex")`). Emitting
 * raw hex on the EVM path was finding 2 — every adapter-path EVM settle threw
 * in the encoder before gas estimation.
 */
function formatAdapterCallId(vm: "solana" | "evm", callId: string): string {
  const hex = parseCallId(callId).reduce(
    (acc, b) => acc + b.toString(16).padStart(2, "0"),
    "",
  );
  return vm === "evm" ? `0x${hex}` : hex;
}

/**
 * Accept either a UUID-style "00000000-0000-0000-0000-000000000000" callId or
 * a 32-char hex string. Always emit 16 raw bytes — the on-chain handler stores
 * call_id as `[u8;16]`.
 */
function parseCallId(callId: string): Uint8Array {
  const hex = callId.replace(/-/g, "");
  if (hex.length !== 32) {
    throw new Error(`callId must be 16 bytes (32 hex chars); got "${callId}"`);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function parseEventTimestamp(d: Record<string, unknown>): number {
  const tsField = d["ts"] ?? d["timestamp"];
  if (typeof tsField === "number") return tsField;
  if (typeof tsField === "string") {
    // ISO-8601 (wrap library default) — convert to unix seconds.
    if (tsField.includes("T") || tsField.endsWith("Z")) {
      const ms = Date.parse(tsField);
      if (!Number.isFinite(ms)) {
        throw new Error(`unparseable ts "${tsField}"`);
      }
      return Math.floor(ms / 1000);
    }
    // Numeric string fallback — treat as unix seconds.
    return Number(tsField);
  }
  throw new Error("settlement event missing ts/timestamp");
}
