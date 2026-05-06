import { fetchAgent } from "@/lib/api";
import { AgentApprovalPanel } from "@/components/agent-approval-panel";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatUsdcShort, formatLatency, formatRelativeTime } from "@/lib/format";

export default async function AgentPage({
  params,
}: {
  params: Promise<{ pubkey: string }>;
}) {
  const { pubkey } = await params;
  const { agent, recentCalls } = await fetchAgent(pubkey);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-serif text-3xl text-[#f5f0eb] mb-1">Agent</h1>
        <p className="font-mono text-sm text-[#8a7a70] break-all">{pubkey}</p>
      </div>

      <AgentApprovalPanel pubkey={pubkey} initialState={agent} />

      <div>
        <h2 className="font-serif text-xl text-[#f5f0eb] mb-3">Call History</h2>
        {recentCalls.length === 0 ? (
          <p className="text-sm text-[#8a7a70]">No calls recorded for this agent.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Endpoint</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Premium</TableHead>
                <TableHead>Refund</TableHead>
                <TableHead>Latency</TableHead>
                <TableHead>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentCalls.map((call) => (
                <TableRow key={call.id}>
                  <TableCell>{call.endpointName}</TableCell>
                  <TableCell>
                    <Badge variant={call.status}>{call.status}</Badge>
                  </TableCell>
                  <TableCell className="text-[#B87333]">${formatUsdcShort(call.premium)}</TableCell>
                  <TableCell className={call.refund > 0 ? "text-[#C9553D]" : "text-[#3a3430]"}>
                    {call.refund > 0 ? `$${formatUsdcShort(call.refund)}` : "—"}
                  </TableCell>
                  <TableCell>{formatLatency(call.latencyMs)}</TableCell>
                  <TableCell className="text-[#8a7a70]">{formatRelativeTime(call.ts)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
