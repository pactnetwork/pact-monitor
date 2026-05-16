export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#fafaf7', color: '#1a1a1a' }}>{children}</body>
    </html>
  );
}

export const metadata = {
  title:       'Pact-0G',
  description: 'On-chain reliability insurance for 0G Compute inference calls',
};
