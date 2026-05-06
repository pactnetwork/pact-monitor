"use client";

import Link from "next/link";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

export function SiteHeader() {
  return (
    <header className="border-b border-[#2a2420] bg-[#151311]">
      <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
        <nav className="flex items-center gap-6">
          <Link href="/" className="font-serif text-lg text-[#B87333] hover:no-underline">
            Pact Market
          </Link>
          <Link href="/endpoints" className="text-sm text-[#8a7a70] hover:text-[#f5f0eb]">
            Endpoints
          </Link>
          <Link href="/agents" className="text-sm text-[#8a7a70] hover:text-[#f5f0eb]">
            Agents
          </Link>
        </nav>
        <WalletMultiButton
          style={{
            backgroundColor: "#2a2420",
            color: "#f5f0eb",
            fontFamily: "JetBrains Mono, monospace",
            fontSize: "12px",
            height: "32px",
            borderRadius: 0,
          }}
        />
      </div>
    </header>
  );
}
