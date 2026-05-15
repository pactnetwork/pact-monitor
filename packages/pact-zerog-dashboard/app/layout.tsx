export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#151311', color: '#fff' }}>{children}</body>
    </html>
  );
}

export const metadata = {
  title:       'Pact-0G',
  description: 'On-chain reliability insurance for 0G Compute inference calls',
};
