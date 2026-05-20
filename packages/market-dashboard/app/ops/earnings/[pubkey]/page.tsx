import Link from "next/link";
import { fetchRecipient, fetchRecipientSettlements } from "@/lib/api";
import { formatRelativeTime, formatUsdcShort } from "@/lib/format";

export const revalidate = 5;

interface PageProps {
  params: Promise<{ pubkey: string }>;
  searchParams: Promise<{ cursor?: string; limit?: string }>;
}

export default async function EarningsDetail({
  params,
  searchParams,
}: PageProps) {
  const { pubkey } = await params;
  const { cursor, limit } = await searchParams;
  const parsedLimit = limit ? Math.min(Math.max(Number(limit) || 50, 1), 200) : 50;

  const [lifetime, page] = await Promise.all([
    fetchRecipient(pubkey),
    fetchRecipientSettlements(pubkey, { cursor, limit: parsedLimit }),
  ]);

  const lifetimeBase = safeNumber(lifetime.lifetimeEarnedLamports);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-3xl text-[#f5f0eb] mb-1">
          Affiliate earnings
        </h1>
        <p className="text-sm text-[#8a7a70] font-mono break-all">{pubkey}</p>
      </div>

      <div className="border border-[#2a2420] p-4 space-y-2">
        <div>
          <span className="text-xs text-[#8a7a70] uppercase tracking-wide">
            Lifetime earned
          </span>
          <div className="font-mono text-2xl text-[#B87333]">
            {formatUsdcShort(lifetimeBase)} USDC
          </div>
        </div>
        <div className="text-xs text-[#8a7a70]">
          Recipient kind:&nbsp;
          {lifetime.recipientKind === null ? "—" : recipientKindLabel(lifetime.recipientKind)}
        </div>
        <div className="text-xs text-[#8a7a70]">
          Last updated:&nbsp;
          {lifetime.lastUpdated ? formatRelativeTime(lifetime.lastUpdated) : "never"}
        </div>
      </div>

      <div>
        <h2 className="font-serif text-xl text-[#f5f0eb] mb-2">
          Recent settlements
        </h2>
        {page.items.length === 0 ? (
          <div className="border border-[#2a2420] p-4 text-sm font-mono text-[#8a7a70]">
            No settlements yet for this recipient.
          </div>
        ) : (
          <table className="w-full text-sm font-mono">
            <thead>
              <tr className="text-left text-xs text-[#8a7a70] uppercase tracking-wide border-b border-[#2a2420]">
                <th className="py-2">When</th>
                <th className="py-2">Amount</th>
                <th className="py-2">Kind</th>
                <th className="py-2">Tx</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((item) => (
                <tr key={item.id} className="border-b border-[#1a1714]">
                  <td className="py-2 text-[#f5f0eb]">
                    {formatRelativeTime(item.settledAt)}
                  </td>
                  <td className="py-2 text-[#B87333]">
                    {formatUsdcShort(safeNumber(item.amountLamports))} USDC
                  </td>
                  <td className="py-2 text-[#5A6B7A]">
                    {recipientKindLabel(item.recipientKind)}
                  </td>
                  <td className="py-2 text-[#8a7a70]">
                    <a
                      href={`https://explorer.solana.com/tx/${item.txSignature}?cluster=devnet`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      {item.txSignature.slice(0, 8)}…
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {page.nextCursor && (
          <div className="mt-3">
            <Link
              href={`/ops/earnings/${encodeURIComponent(pubkey)}?cursor=${encodeURIComponent(page.nextCursor)}&limit=${parsedLimit}`}
              className="text-sm font-mono text-[#B87333] underline"
            >
              Next page →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

function recipientKindLabel(kind: number): string {
  switch (kind) {
    case 0:
      return "Treasury";
    case 1:
      return "AffiliateAta";
    case 2:
      return "AffiliatePda";
    default:
      return `kind=${kind}`;
  }
}

/** Lamport string → number safely (clamps at MAX_SAFE_INTEGER). */
function safeNumber(s: string): number {
  try {
    const b = BigInt(s);
    if (b > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
    return Number(b);
  } catch {
    return 0;
  }
}
