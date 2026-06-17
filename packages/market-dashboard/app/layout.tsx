import "./globals.css";
import type { Metadata } from "next";
import { Inria_Sans, Inria_Serif, JetBrains_Mono } from "next/font/google";
import { SolanaWalletProvider } from "@/components/wallet-provider";
import { SiteHeader } from "@/components/site-header";

// Self-hosted fonts via next/font (no runtime Google-Fonts CDN dependency).
const inriaSans = Inria_Sans({
  subsets: ["latin"],
  weight: ["300", "400", "700"],
  display: "swap",
  variable: "--font-inria-sans",
});

const inriaSerif = Inria_Serif({
  subsets: ["latin"],
  weight: ["400", "700"],
  style: ["normal", "italic"],
  display: "swap",
  variable: "--font-inria-serif",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "Pact Explorer",
  description: "Parametric API coverage for AI agents",
  openGraph: {
    title: "Pact Explorer",
    description: "Parametric API coverage for AI agents",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${inriaSans.variable} ${inriaSerif.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        <SolanaWalletProvider>
          <SiteHeader />
          <main className="max-w-7xl mx-auto px-4 py-6">{children}</main>
        </SolanaWalletProvider>
      </body>
    </html>
  );
}
