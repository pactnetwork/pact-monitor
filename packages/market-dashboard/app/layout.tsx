import "./globals.css";
import type { Metadata } from "next";

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
      <body>{children}</body>
    </html>
  );
}
