import {
  Controller,
  Get,
  Param,
  Query,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * Public read API for fee recipient earnings (no auth — matches the
 * Drift / Helius / Solscan convention for per-account reads).
 *
 * Wire shape, BigInts serialized as decimal strings per the rest of the
 * indexer (see endpoints.controller.ts / stats.service.ts).
 *
 * Two routes:
 *   - GET /api/recipients/:pubkey                — lifetime aggregates.
 *     Returns a ZERO envelope (200, not 404) when the pubkey has no
 *     RecipientEarnings row. Reasoning: a pubkey with no earnings is a
 *     legitimate state (never settled / not yet configured), and JSON:API
 *     v1.1 mandates 200 for empty resources. Diverges from
 *     agents.controller.ts:89 by design — affiliates are derived identities.
 *   - GET /api/recipients/:pubkey/settlements?cursor=<base64url>&limit=N
 *     — reverse-chronological list of fee-recipient shares. Cursor is
 *     base64url(SettlementRecipientShare.id) — cuid is monotonic by
 *     creation time and uniquely indexed (PK). Empty result = 200 with
 *     items:[] and nextCursor:null. Limit clamped [1, 200] (matches
 *     agents.controller.ts).
 *
 * The settlement-batch model has no per-share endpoint slug or callId
 * (settle_batch fans out across multiple events in one tx), so the
 * `items[]` schema is intentionally minimal: id, settledAt, txSignature,
 * amountLamports, recipientKind. The SDK joins to /api/endpoints if it
 * needs slug-level breakdown.
 */
@Controller("api/recipients")
export class RecipientsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(":pubkey")
  async getRecipientEarnings(
    @Param("pubkey") pubkey: string,
  ): Promise<RecipientEarningsWire> {
    const row = await this.prisma.recipientEarnings.findUnique({
      where: { recipientPubkey: pubkey },
    });
    if (!row) {
      return {
        recipientPubkey: pubkey,
        recipientKind: null,
        lifetimeEarnedLamports: "0",
        lastUpdated: null,
      };
    }
    return {
      recipientPubkey: row.recipientPubkey,
      recipientKind: row.recipientKind,
      lifetimeEarnedLamports: row.lifetimeEarnedLamports.toString(),
      lastUpdated: row.lastUpdated.toISOString(),
    };
  }

  @Get(":pubkey/settlements")
  async getRecipientSettlements(
    @Param("pubkey") pubkey: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limitStr?: string,
  ): Promise<RecipientSettlementsPage> {
    const parsed = Number(limitStr);
    const limit = Math.min(
      Math.max(Number.isFinite(parsed) && parsed > 0 ? parsed : 50, 1),
      200,
    );
    const decodedCursor = decodeCursor(cursor);

    const rows = await this.prisma.settlementRecipientShare.findMany({
      where: {
        recipientPubkey: pubkey,
        ...(decodedCursor ? { id: { lt: decodedCursor } } : {}),
      },
      orderBy: { id: "desc" },
      take: limit,
      include: { settlement: true },
    });

    const items: RecipientSettlementItem[] = rows.map((r) => ({
      id: r.id,
      settledAt: r.settlement.ts.toISOString(),
      txSignature: r.settlement.signature,
      amountLamports: r.amountLamports.toString(),
      recipientKind: r.recipientKind,
    }));

    // nextCursor = id of last item, opaque base64url. Null iff fewer than
    // `limit` rows returned (last page).
    const nextCursor =
      rows.length === limit ? encodeCursor(rows[rows.length - 1].id) : null;

    return { items, nextCursor };
  }
}

function encodeCursor(cuid: string): string {
  return Buffer.from(cuid, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor || cursor.length === 0) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    // Sanity-check: cuids are >= 7 chars and consist of [a-z0-9].
    if (decoded.length < 7 || !/^[a-z0-9]+$/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

interface RecipientEarningsWire {
  recipientPubkey: string;
  recipientKind: number | null;
  lifetimeEarnedLamports: string;
  lastUpdated: string | null;
}

interface RecipientSettlementItem {
  id: string;
  settledAt: string;
  txSignature: string;
  amountLamports: string;
  recipientKind: number;
}

interface RecipientSettlementsPage {
  items: RecipientSettlementItem[];
  nextCursor: string | null;
}
