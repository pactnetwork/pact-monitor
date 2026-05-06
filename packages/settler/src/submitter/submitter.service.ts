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
 * by `buildSettleBatchIx` from @pact-network/protocol-v1-client — we don't
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
} from "@pact-network/protocol-v1-client";

import { SettleBatch } from "../batcher/batcher.service";
import { SecretLoaderService } from "../config/secret-loader.service";

const ENDPOINT_CACHE_TTL_MS = 60_000;
const DEFAULT_PROGRAM_ID = "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5";

export class BatchSubmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchSubmitError";
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

@Injectable()
export class SubmitterService implements OnModuleInit {
  private readonly logger = new Logger(SubmitterService.name);
  private readonly connection: Connection;
  private readonly programId: PublicKey;
  private readonly usdcMint: PublicKey;
  private readonly settlementAuthorityPda: PublicKey;
  private readonly treasuryPda: PublicKey;
  /**
   * Canonical [b"protocol_config"] PDA. Required as fixed account index 4 of
   * every `settle_batch` tx — the on-chain handler reads `paused` here and
   * rejects the entire batch with `PactError::ProtocolPaused (6032)` before
   * any per-event work runs (mainnet kill switch, 2026-05-06).
   *
   * The settler does NOT need to read or decode the account — the program
   * does its own load + verify. We just supply the PDA so the program can
   * deref its own data buffer.
   */
  private readonly protocolConfigPda: PublicKey;
  private treasuryVault: PublicKey | null = null;
  private readonly endpointCache = new Map<string, EndpointSnapshot>();

  constructor(
    private readonly config: ConfigService,
    private readonly secrets: SecretLoaderService,
  ) {
    const rpc = this.config.getOrThrow<string>("SOLANA_RPC_URL");
    this.connection = new Connection(rpc, "confirmed");
    this.programId = new PublicKey(
      this.config.get<string>("PROGRAM_ID") ?? DEFAULT_PROGRAM_ID,
    );
    // Default to devnet USDC; mainnet flow overrides via env (USDC_MINT).
    this.usdcMint = new PublicKey(
      this.config.get<string>("USDC_MINT") ?? USDC_MINT_DEVNET.toBase58(),
    );
    [this.settlementAuthorityPda] = getSettlementAuthorityPda(this.programId);
    [this.treasuryPda] = getTreasuryPda(this.programId);
    [this.protocolConfigPda] = getProtocolConfigPda(this.programId);
  }

  async onModuleInit(): Promise<void> {
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

  async submit(batch: SettleBatch): Promise<SettlementOutcome> {
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
      const agentAta = deriveAssociatedTokenAccount(agentOwner, this.usdcMint);
      const premiumLamports = BigInt(d["premiumLamports"] as string | number);
      const refundLamports = BigInt(
        (d["refundLamports"] as string | number | undefined) ?? "0",
      );
      const latencyMs = Number(d["latencyMs"] ?? 0);
      const outcomeStr = String(d["outcome"] ?? "ok");
      const breach = breachFromOutcome(outcomeStr);
      const ts = parseEventTimestamp(d);

      // Resolve per-recipient ATAs in EndpointConfig order. Treasury entries
      // are mapped to the Treasury USDC vault (singleton); Affiliate* kinds
      // already store the destination ATA/PDA in EndpointConfig.
      const feeRecipientAtas: PublicKey[] = [];
      const shares: RecipientShare[] = [];
      const feeRecipientCount = snap.config.feeRecipientCount;
      for (let i = 0; i < feeRecipientCount; i++) {
        const r = snap.config.feeRecipients[i];
        let dest: PublicKey;
        if (r.kind === FeeRecipientKind.Treasury) {
          const vault = await this.requireTreasuryVault();
          dest = vault;
        } else {
          dest = new PublicKey(r.destination);
        }
        feeRecipientAtas.push(dest);
        // Mirror on-chain math: floor(premium * bps / 10_000).
        const amount = (premiumLamports * BigInt(r.bps)) / 10_000n;
        shares.push({
          kind: r.kind,
          pubkey: dest.toBase58(),
          amountLamports: amount,
        });
      }

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
      callRecordPdas.push(getCallRecordPda(this.programId, callId)[0]);
      perEventShares.push(shares);
    }

    const ix = buildSettleBatchIx({
      programId: this.programId,
      settler,
      settlementAuthority: this.settlementAuthorityPda,
      // Mainnet kill switch (2026-05-06): ProtocolConfig sits at fixed
      // account index 4. The on-chain handler reads `paused` here and
      // rejects the entire batch (PactError::ProtocolPaused = 6032) before
      // any per-event work runs.
      protocolConfig: this.protocolConfigPda,
      events,
      callRecordPdas,
    });

    // Compute-budget instructions are mandatory for settle_batch. Each event
    // performs 1 SPL Token Transfer (premium-in) + 1-9 SPL Token Transfers
    // (fee fan-out + optional refund) + 1 CallRecord init. The default 200k
    // CU/tx limit is exceeded after ~3 events with 1 fee recipient. The
    // priority-fee floor keeps txs landing during devnet/mainnet congestion.
    //
    // Sized for the 5-event MAX_BATCH_SIZE cap with up to 8 fee recipients
    // each: ~5 × 5 ix × ~20k CU ≈ 500k headroom; doubled to 1_000_000 for
    // safety. Tune downward once we have measured CU per event from
    // surfpool/devnet logs.
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
        return sendAndConfirmTransaction(this.connection, tx, [keypair], {
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
    const slugBuf = slugBytes(slug);
    const [endpointConfigPda] = getEndpointConfigPda(this.programId, slugBuf);
    const [coveragePool] = getCoveragePoolPda(this.programId, slugBuf);

    const [epAcct, poolAcct] = await Promise.all([
      this.connection.getAccountInfo(endpointConfigPda, "confirmed"),
      this.connection.getAccountInfo(coveragePool, "confirmed"),
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
    const acct = await this.connection.getAccountInfo(
      this.treasuryPda,
      "confirmed",
    );
    if (!acct) {
      throw new Error(`Treasury PDA ${this.treasuryPda.toBase58()} not initialised`);
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
    const acct = await this.connection.getAccountInfo(callRecordPda, "confirmed");
    if (!acct) return null;
    const sigs = await this.connection.getSignaturesForAddress(callRecordPda, {
      limit: 1,
    });
    return sigs[0]?.signature ?? null;
  }

  // For consumers that want direct access to derived constants (used by tests).
  get derivedSettlementAuthorityPda(): PublicKey {
    return this.settlementAuthorityPda;
  }

  get derivedTreasuryPda(): PublicKey {
    return this.treasuryPda;
  }

  get derivedProtocolConfigPda(): PublicKey {
    return this.protocolConfigPda;
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
