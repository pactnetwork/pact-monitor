import Link from "next/link";
import { fetchCalls } from "@/lib/api";
import { formatUsdcShort, formatPubkey, formatRelativeTime } from "@/lib/format";
import { Card, CardHeader, CardTitle, CardValue } from "@/components/ui/card";

export const revalidate = 5;

export default async function AgentsPage() {
  const calls = await fetchCalls(50);

  // Aggregate unique agents from recent calls
  const agentMap = new Map<string, { premiums: number; refunds: number; callCount: number; lastActivity: string }>();
  for (const call of calls) {
    const existing = agentMap.get(call.agentPubkey);
    if (existing) {
      existing.premiums += call.premium;
      existing.refunds += call.refund;
      existing.callCount += 1;
    } else {
      agentMap.set(call.agentPubkey, {
        premiums: call.premium,
        refunds: call.refund,
        callCount: 1,
        lastActivity: call.ts,
      });
    }
  }
  const agents = Array.from(agentMap.entries()).sort(
    (a, b) => b[1].premiums - a[1].premiums
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-3xl text-[#f5f0eb] mb-1">Agents</h1>
        <p className="text-sm text-[#8a7a70]">Active wallets by premiums paid (last 50 calls)</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {agents.map(([pubkey, stats]) => (
          <Link key={pubkey} href={`/agents/${pubkey}`} className="block hover:no-underline">
            <Card className="hover:border-[#B87333] transition-colors cursor-pointer">
              <CardHeader>
                <CardTitle>{formatPubkey(pubkey)}</CardTitle>
              </CardHeader>
              <div className="font-mono text-xs text-[#8a7a70] truncate mb-3">{pubkey}</div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div>
                  <div className="text-[#8a7a70] uppercase tracking-wide mb-1">Premiums</div>
                  <div className="text-[#B87333] font-mono">{formatUsdcShort(stats.premiums)}</div>
                </div>
                <div>
                  <div className="text-[#8a7a70] uppercase tracking-wide mb-1">Refunds</div>
                  <div className={`font-mono ${stats.refunds > 0 ? "text-[#C9553D]" : "text-[#3a3430]"}`}>
                    {stats.refunds > 0 ? formatUsdcShort(stats.refunds) : "—"}
                  </div>
                </div>
                <div>
                  <div className="text-[#8a7a70] uppercase tracking-wide mb-1">Calls</div>
                  <div className="text-[#f5f0eb] font-mono">{stats.callCount}</div>
                </div>
              </div>
              <div className="text-xs text-[#8a7a70] mt-2">{formatRelativeTime(stats.lastActivity)}</div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
