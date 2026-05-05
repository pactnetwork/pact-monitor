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
      events,
      callRecordPdas,
    });

    const signature = await this.sendWithRetry(async () => {
      const tx = new Transaction().add(ix);
      return sendAndConfirmTransaction(this.connection, tx, [keypair], {
        commitment: "confirmed",
      });
    }, 3);

    return { signature, perEventShares };
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

  private async sendWithRetry(
    fn: () => Promise<string>,
    maxAttempts: number,
  ): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
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
    throw new BatchSubmitError(
      `All ${maxAttempts} submit attempts failed: ${lastErr}`,
    );
  }

  // For consumers that want direct access to derived constants (used by tests).
  get derivedSettlementAuthorityPda(): PublicKey {
    return this.settlementAuthorityPda;
  }

  get derivedTreasuryPda(): PublicKey {
    return this.treasuryPda;
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
