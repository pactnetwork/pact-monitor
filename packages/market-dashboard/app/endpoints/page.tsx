import { fetchEndpoints } from "@/lib/api";
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
  formatFailureRate,
} from "@/lib/format";

export const revalidate = 5;

export default async function EndpointsPage() {
  const endpoints = await fetchEndpoints();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-3xl text-[#f5f0eb] mb-1">Endpoints</h1>
        <p className="text-sm text-[#8a7a70]">
          Registered API providers, per-endpoint pool balances, and fee
          recipient splits.
        </p>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Flat Fee</TableHead>
            <TableHead>SLA</TableHead>
            <TableHead>Calls 24h</TableHead>
            <TableHead>Failure Rate</TableHead>
            <TableHead>Pool Balance</TableHead>
            <TableHead>Fee Recipients</TableHead>
            <TableHead>Pool Retains</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {endpoints.map((ep) => (
            <TableRow key={ep.id}>
              <TableCell>
                <div>
                  <div className="text-[#f5f0eb] font-medium">{ep.name}</div>
                  <div className="text-xs text-[#8a7a70] truncate max-w-[200px]">
                    {ep.url}
                  </div>
                </div>
              </TableCell>
              <TableCell>
                <Badge variant={ep.isActive ? "ok" : "error"}>
                  {ep.isActive ? "active" : "inactive"}
                </Badge>
              </TableCell>
              <TableCell className="text-[#B87333]">
                ${formatUsdcShort(ep.flatFee)}
              </TableCell>
              <TableCell>{formatLatency(ep.slaMs)}</TableCell>
              <TableCell>{ep.calls24h.toLocaleString()}</TableCell>
              <TableCell>
                <span
                  className={
                    ep.failureRate24h > 0.02
                      ? "text-[#C9553D]"
                      : "text-[#5A6B7A]"
                  }
                >
                  {formatFailureRate(ep.failureRate24h)}
                </span>
              </TableCell>
              <TableCell className="text-[#B87333]">
                {formatUsdcShort(ep.poolBalance)}
              </TableCell>
              <TableCell className="text-xs text-[#8a7a70] font-mono">
                {ep.feeRecipients.map((r) => r.label).join(" + ")}
              </TableCell>
              <TableCell className="text-[#5A6B7A]">
                {(ep.poolRetainedBps / 100).toFixed(0)}%
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
