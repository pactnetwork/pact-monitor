import "./globals.css";
import type { Metadata } from "next";
import { SolanaWalletProvider } from "@/components/wallet-provider";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = {
  title: "Pact Network Dashboard",
  description: "Parametric API coverage for AI agents",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inria+Serif:ital,wght@0,400;0,700;1,400;1,700&family=Inria+Sans:wght@300;400;700&family=JetBrains+Mono:wght@400;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <SolanaWalletProvider>
          <SiteHeader />
          <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
        </SolanaWalletProvider>
      </body>
    </html>
  );
}
