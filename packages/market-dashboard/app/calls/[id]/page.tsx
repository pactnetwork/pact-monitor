import { fetchCall } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardValue } from "@/components/ui/card";
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

export default async function CallPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const call = await fetchCall(id);

  if (!call) {
    return (
      <div className="space-y-4">
        <h1 className="font-serif text-3xl text-[#f5f0eb]">Call not found</h1>
        <p className="text-sm text-[#8a7a70]">
          No CallRecord PDA matches <span className="font-mono">{id}</span>.
        </p>
      </div>
    );
  }

  const breach = call.refund > 0;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-serif text-3xl text-[#f5f0eb] mb-1">Call</h1>
        <p className="font-mono text-sm text-[#8a7a70] break-all">{call.id}</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Status</CardTitle>
          </CardHeader>
          <CardValue>
            <Badge variant={call.status}>{call.status}</Badge>
          </CardValue>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Premium</CardTitle>
          </CardHeader>
          <CardValue className="text-[#B87333]">
            {formatUsdcShort(call.premium)}
          </CardValue>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Refund</CardTitle>
          </CardHeader>
          <CardValue className={breach ? "text-[#C9553D]" : "text-[#3a3430]"}>
            {breach ? formatUsdcShort(call.refund) : "—"}
          </CardValue>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Latency</CardTitle>
          </CardHeader>
          <CardValue>{formatLatency(call.latencyMs)}</CardValue>
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="text-xs text-[#8a7a70] uppercase tracking-wide mb-1">
            Agent
          </div>
          <a
            href={`/agents/${call.agentPubkey}`}
            className="text-[#B87333] hover:underline font-mono text-sm"
          >
            {formatPubkey(call.agentPubkey)}
          </a>
        </div>
        <div>
          <div className="text-xs text-[#8a7a70] uppercase tracking-wide mb-1">
            Endpoint
          </div>
          <div className="text-[#f5f0eb]">{call.endpointName}</div>
          <div className="text-xs text-[#8a7a70] font-mono">
            slug={call.endpointSlug}
          </div>
        </div>
        <div>
          <div className="text-xs text-[#8a7a70] uppercase tracking-wide mb-1">
            Settled
          </div>
          <div className="text-[#f5f0eb]">{formatRelativeTime(call.ts)}</div>
        </div>
      </div>

      {call.recipientShares && call.recipientShares.length > 0 && (
        <div>
          <h2 className="font-serif text-xl text-[#f5f0eb] mb-3">
            Settlement Split
          </h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Destination</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>BPS</TableHead>
                <TableHead>Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {call.recipientShares.map((s) => (
                <TableRow key={s.destination}>
                  <TableCell className="font-mono text-xs">
                    {formatPubkey(s.destination)}
                  </TableCell>
                  <TableCell className="text-[#8a7a70]">{s.kind}</TableCell>
                  <TableCell>{s.bps}</TableCell>
                  <TableCell className="text-[#B87333]">
                    {formatUsdcShort(s.amount)}
                  </TableCell>
                </TableRow>
              ))}
              {call.poolRetained !== undefined && (
                <TableRow>
                  <TableCell className="font-mono text-xs text-[#5A6B7A]">
                    coverage_pool (retained)
                  </TableCell>
                  <TableCell className="text-[#8a7a70]">pool</TableCell>
                  <TableCell>—</TableCell>
                  <TableCell className="text-[#5A6B7A]">
                    {formatUsdcShort(call.poolRetained)}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
