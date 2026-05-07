import "./globals.css";
import type { Metadata } from "next";
import { SolanaWalletProvider } from "@/components/wallet-provider";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Pact Market Dashboard",
  description: "Parametric API insurance for Solana agents",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <SolanaWalletProvider>
          <SiteHeader />
          <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
        </SolanaWalletProvider>
      </body>
    </html>
  );
}
