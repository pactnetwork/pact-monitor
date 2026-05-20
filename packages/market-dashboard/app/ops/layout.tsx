import Link from "next/link";
import { OpsAuthorityGate } from "@/components/ops/authority-gate";

const NAV = [
  { href: "/ops/register", label: "Register" },
  { href: "/ops/pause-endpoint", label: "Pause endpoint" },
  { href: "/ops/endpoint-config", label: "Endpoint config" },
  { href: "/ops/recipients", label: "Fee recipients" },
  { href: "/ops/topup", label: "Top up pool" },
  { href: "/ops/earnings", label: "Affiliate earnings" },
];

export default function OpsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <OpsAuthorityGate>
        <div className="grid grid-cols-[180px_1fr] gap-6">
          <nav className="space-y-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="block px-3 py-2 text-sm font-mono text-[#f5f0eb] hover:bg-[#2a2420] border border-transparent hover:border-[#2a2420]"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="min-w-0">{children}</div>
        </div>
      </OpsAuthorityGate>
    </div>
  );
}
