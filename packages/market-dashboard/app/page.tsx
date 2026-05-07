import { fetchStats, fetchCalls } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardValue } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatUsdcShort,
  formatLatency,
  formatRelativeTime,
  formatPubkey,
} from "@/lib/format";

export const revalidate = 5;

export default async function HomePage() {
  const [stats, calls] = await Promise.all([fetchStats(), fetchCalls(50)]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-serif text-3xl text-[#f5f0eb] mb-1">Pact Market</h1>
        <p className="text-sm text-[#8a7a70]">
          Parametric API insurance for Solana agents — devnet
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Pool Balance (Aggregate)</CardTitle>
          </CardHeader>
          <CardValue>{formatUsdcShort(stats.poolBalanceAggregate)}</CardValue>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Treasury Earned</CardTitle>
          </CardHeader>
          <CardValue className="text-[#5A6B7A]">
            {formatUsdcShort(stats.treasuryEarned)}
          </CardValue>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Total Premiums</CardTitle>
          </CardHeader>
          <CardValue>{formatUsdcShort(stats.totalPremiums)}</CardValue>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Total Refunds</CardTitle>
          </CardHeader>
          <CardValue className="text-[#C9553D]">
            {formatUsdcShort(stats.totalRefunds)}
          </CardValue>
        </Card>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Calls Insured</CardTitle>
          </CardHeader>
          <CardValue className="text-[#f5f0eb]">
            {stats.callsInsured.toLocaleString()}
          </CardValue>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Active Endpoints</CardTitle>
          </CardHeader>
          <CardValue className="text-[#5A6B7A]">
            {stats.activeEndpoints}
          </CardValue>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Active Agents</CardTitle>
          </CardHeader>
          <CardValue className="text-[#5A6B7A]">{stats.activeAgents}</CardValue>
        </Card>
      </div>

      {stats.topRecipients.length > 0 && (
        <div>
          <h2 className="font-serif text-xl text-[#f5f0eb] mb-3">
            Top Integrators
          </h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Recipient</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Lifetime Earned</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.topRecipients.map((r) => (
                <TableRow key={r.destination}>
                  <TableCell>
                    <div className="text-[#f5f0eb]">{r.label}</div>
                    <div className="text-xs text-[#8a7a70] font-mono">
                      {formatPubkey(r.destination)}
                    </div>
                  </TableCell>
                  <TableCell className="text-[#8a7a70]">{r.kind}</TableCell>
                  <TableCell className="text-[#B87333]">
                    {formatUsdcShort(r.totalEarned)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div>
        <h2 className="font-serif text-xl text-[#f5f0eb] mb-3">Recent Events</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Endpoint</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Premium</TableHead>
              <TableHead>Refund</TableHead>
              <TableHead>Latency</TableHead>
              <TableHead>Time</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {calls.map((call) => (
              <TableRow key={call.id}>
                <TableCell>
                  <a
                    href={`/agents/${call.agentPubkey}`}
                    className="text-[#B87333] hover:underline"
                  >
                    {formatPubkey(call.agentPubkey)}
                  </a>
                </TableCell>
                <TableCell className="text-[#8a7a70]">
                  {call.endpointName}
                </TableCell>
                <TableCell>
                  <Badge variant={call.status}>{call.status}</Badge>
                </TableCell>
                <TableCell className="text-[#B87333]">
                  ${formatUsdcShort(call.premium)}
                </TableCell>
                <TableCell
                  className={
                    call.refund > 0 ? "text-[#C9553D]" : "text-[#3a3430]"
                  }
                >
                  {call.refund > 0 ? `$${formatUsdcShort(call.refund)}` : "—"}
                </TableCell>
                <TableCell>{formatLatency(call.latencyMs)}</TableCell>
                <TableCell className="text-[#8a7a70]">
                  {formatRelativeTime(call.ts)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
