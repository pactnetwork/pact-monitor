import Link from "next/link";

const SECTIONS = [
  {
    href: "/ops/register",
    title: "Register",
    blurb: "Create a new EndpointConfig + CoveragePool. Generates a throwaway pool vault.",
  },
  {
    href: "/ops/pause-endpoint",
    title: "Pause endpoint",
    blurb: "Toggle per-endpoint paused flag. Distinct from the global pause kill switch.",
  },
  {
    href: "/ops/endpoint-config",
    title: "Endpoint config",
    blurb: "Partial update of pricing / SLA / cost / exposure cap fields.",
  },
  {
    href: "/ops/recipients",
    title: "Fee recipients",
    blurb: "Replace the EndpointConfig.fee_recipients array. Row-builder UI.",
  },
  {
    href: "/ops/topup",
    title: "Top up pool",
    blurb: "Send USDC into a CoveragePool. Uses per-pool authority (NOT ProtocolConfig).",
  },
  {
    href: "/ops/earnings",
    title: "Affiliate earnings",
    blurb: "Lifetime + paginated settlements for a fee recipient. Read-only.",
  },
];

export default function OpsHome() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-3xl text-[#f5f0eb] mb-1">
          Operator console
        </h1>
        <p className="text-sm text-[#8a7a70]">
          Wallet-adapter driven. All writes go to the connected wallet for
          signing. Affiliate reads come from the public indexer (no signer
          required).
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {SECTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="block border border-[#2a2420] p-4 hover:bg-[#1f1a17]"
          >
            <div className="font-serif text-xl text-[#f5f0eb]">{s.title}</div>
            <div className="text-sm text-[#8a7a70] mt-1">{s.blurb}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
