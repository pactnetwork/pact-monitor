export default function Page() {
  return (
    <main style={{ padding: 32, fontFamily: 'monospace' }}>
      <h1>Pact-0G dashboard</h1>
      <p>Skeleton. Real panels (pool live, recent calls, wallet, demo runner) land in Week 3.</p>
      <ul>
        <li>Pool live — per-endpoint balance + lifetime stats</li>
        <li>Recent calls — last 20 settled calls with explorer + 0G Storage links</li>
        <li>Wallet panel — wagmi connect, mUSDC balance + allowance, top-up button</li>
        <li>Demo runner — fire N inference calls against the insured 0G Compute endpoint</li>
      </ul>
    </main>
  );
}
