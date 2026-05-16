import { createPublicClient, http, formatUnits, type Address, type Hex } from 'viem';
import { pactCoreAbi } from '@pact-network/protocol-zerog-client';

// Render per request — avoids hitting the 0G RPC during `next build`
// (which would crash if the chain or env is misconfigured at build time).
export const dynamic = 'force-dynamic';
export const revalidate = 15;

const ARISTOTLE = {
  id: 16661,
  name: '0G Mainnet (Aristotle)',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: { default: { http: [process.env.ZEROG_RPC_URL ?? 'https://evmrpc.0g.ai'] } },
  blockExplorers: { default: { name: 'ChainScan', url: 'https://chainscan.0g.ai' } },
} as const;

const USDC_DECIMALS = 6;
// trim() — Vercel can append whitespace when env vars are set via stdin
const PACT_CORE = ((process.env.PACT_CORE_ADDRESS ?? '').trim()) as Address;

const STATUS_LABELS = [
  'Unsettled',
  'Settled',
  'DelegateFailed',
  'PoolDepleted',
  'ExposureCapClamped',
] as const;

const STATUS_COLORS: Record<string, string> = {
  Settled: '#5A6B7A',
  DelegateFailed: '#C9553D',
  PoolDepleted: '#C9553D',
  ExposureCapClamped: '#B87333',
  Unsettled: '#888',
};

type CallSettled = {
  callId: Hex;
  slug: Hex;
  agent: Address;
  status: number;
  premium: bigint;
  refund: bigint;
  actualRefund: bigint;
  rootHash: Hex;
  txHash: Hex;
  blockNumber: bigint;
};

async function fetchRecentCalls(): Promise<{ calls: CallSettled[]; head: bigint; error: string | null }> {
  if (!PACT_CORE || !/^0x[0-9a-fA-F]{40}$/.test(PACT_CORE)) {
    return { calls: [], head: 0n, error: null };
  }
  try {
    const client = createPublicClient({ chain: ARISTOTLE, transport: http() });
    const head = await client.getBlockNumber();
    // Look back ~50k blocks — at 0G's sub-second block time this is roughly a
    // day of history. Adjust if RPC complains about range size.
    const fromBlock = head > 50_000n ? head - 50_000n : 0n;
    const logs = await client.getContractEvents({
      address: PACT_CORE,
      abi: pactCoreAbi,
      eventName: 'CallSettled',
      fromBlock,
      toBlock: head,
    });
    const calls: CallSettled[] = logs
      .slice()
      .reverse()
      .slice(0, 20)
      .map((log) => ({
      callId: log.args.callId as Hex,
      slug: log.args.slug as Hex,
      agent: log.args.agent as Address,
      status: Number(log.args.status),
      premium: log.args.premium as bigint,
      refund: log.args.refund as bigint,
      actualRefund: log.args.actualRefund as bigint,
      rootHash: log.args.rootHash as Hex,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
    }));
    return { calls, head, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { calls: [], head: 0n, error: msg };
  }
}

function decodeSlug(hex: Hex): string {
  const bytes = hex.slice(2).match(/.{1,2}/g) ?? [];
  const ascii = bytes
    .map((b) => parseInt(b, 16))
    .filter((c) => c >= 32 && c < 127)
    .map((c) => String.fromCharCode(c))
    .join('');
  return ascii.replace(/\0+$/, '').trim() || hex;
}

function shortHex(h: string, leading = 6, trailing = 4) {
  if (h.length <= leading + trailing + 2) return h;
  return `${h.slice(0, leading)}…${h.slice(-trailing)}`;
}

const explorer = ARISTOTLE.blockExplorers.default.url;

export default async function Page() {
  const { calls, head, error } = await fetchRecentCalls();

  return (
    <main
      style={{
        padding: '32px 24px',
        maxWidth: 1100,
        margin: '0 auto',
        fontFamily:
          'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace',
        color: '#1a1a1a',
        background: '#fafaf7',
        minHeight: '100vh',
      }}
    >
      <header style={{ borderBottom: '2px solid #1a1a1a', paddingBottom: 16, marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontFamily: 'Inria Serif, Georgia, serif', fontWeight: 400 }}>
          Pact-0G
        </h1>
        <p style={{ margin: '8px 0 0 0', color: '#555' }}>
          Insurance protocol for AI agent API calls on{' '}
          <a href={explorer} style={{ color: '#B87333' }}>
            0G Mainnet
          </a>
          {' · '}
          <a
            href="https://github.com/pactnetwork/pact-monitor/pull/206"
            style={{ color: '#B87333' }}
          >
            0G APAC Hackathon submission
          </a>
        </p>
      </header>

      <section style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: 1, color: '#888' }}>
          Protocol state
        </h2>
        <dl style={{ display: 'grid', gridTemplateColumns: '180px 1fr', rowGap: 6 }}>
          <dt>Chain</dt>
          <dd style={{ margin: 0 }}>Aristotle (16661)</dd>
          <dt>PactCore</dt>
          <dd style={{ margin: 0 }}>
            {PACT_CORE ? (
              <a href={`${explorer}/address/${PACT_CORE}`} style={{ color: '#B87333' }}>
                {PACT_CORE}
              </a>
            ) : (
              <span style={{ color: '#C9553D' }}>not deployed — set PACT_CORE_ADDRESS env</span>
            )}
          </dd>
          <dt>Premium token</dt>
          <dd style={{ margin: 0 }}>
            <a
              href={`${explorer}/address/0x1f3AA82227281cA364bFb3d253B0f1af1Da6473E`}
              style={{ color: '#B87333' }}
            >
              USDC.e (XSwap Bridged USDC)
            </a>
          </dd>
          <dt>Latest block</dt>
          <dd style={{ margin: 0 }}>{head.toString()}</dd>
        </dl>
      </section>

      {error && (
        <div
          style={{
            border: '1px solid #C9553D',
            background: '#fdf2ef',
            color: '#a83a25',
            padding: 12,
            marginBottom: 24,
            fontSize: 13,
          }}
        >
          RPC error reading from PactCore: {error}
        </div>
      )}

      <section>
        <h2 style={{ fontSize: 14, textTransform: 'uppercase', letterSpacing: 1, color: '#888' }}>
          Recent settled calls ({calls.length})
        </h2>
        {calls.length === 0 ? (
          <p style={{ color: '#888' }}>
            {PACT_CORE
              ? 'No settled calls yet. Run `pnpm --filter @pact-network/zerog-demo demo` to settle one.'
              : 'Deploy PactCore and set PACT_CORE_ADDRESS in the dashboard env, then refresh.'}
          </p>
        ) : (
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 13,
              marginTop: 8,
            }}
          >
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid #1a1a1a' }}>
                <th style={{ padding: '8px 4px' }}>Block</th>
                <th style={{ padding: '8px 4px' }}>Slug</th>
                <th style={{ padding: '8px 4px' }}>Agent</th>
                <th style={{ padding: '8px 4px' }}>Status</th>
                <th style={{ padding: '8px 4px', textAlign: 'right' }}>Premium</th>
                <th style={{ padding: '8px 4px', textAlign: 'right' }}>Refund</th>
                <th style={{ padding: '8px 4px' }}>Evidence</th>
                <th style={{ padding: '8px 4px' }}>Tx</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c, i) => {
                const label = STATUS_LABELS[c.status] ?? `Unknown(${c.status})`;
                const color = STATUS_COLORS[label] ?? '#1a1a1a';
                return (
                  <tr key={c.callId + ':' + i} style={{ borderBottom: '1px solid #e8e6e0' }}>
                    <td style={{ padding: '8px 4px' }}>{c.blockNumber.toString()}</td>
                    <td style={{ padding: '8px 4px' }}>{decodeSlug(c.slug)}</td>
                    <td style={{ padding: '8px 4px' }}>
                      <a
                        href={`${explorer}/address/${c.agent}`}
                        style={{ color: '#555', textDecoration: 'none' }}
                      >
                        {shortHex(c.agent)}
                      </a>
                    </td>
                    <td style={{ padding: '8px 4px', color, fontWeight: 600 }}>{label}</td>
                    <td style={{ padding: '8px 4px', textAlign: 'right' }}>
                      {formatUnits(c.premium, USDC_DECIMALS)}
                    </td>
                    <td style={{ padding: '8px 4px', textAlign: 'right' }}>
                      {c.actualRefund > 0n ? formatUnits(c.actualRefund, USDC_DECIMALS) : '—'}
                    </td>
                    <td style={{ padding: '8px 4px' }}>
                      {c.rootHash !== '0x' + '00'.repeat(32) ? (
                        <a
                          href={`https://storagescan.0g.ai/file/${c.rootHash}`}
                          style={{ color: '#B87333' }}
                        >
                          {shortHex(c.rootHash, 8, 4)}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td style={{ padding: '8px 4px' }}>
                      <a
                        href={`${explorer}/tx/${c.txHash}`}
                        style={{ color: '#B87333' }}
                      >
                        {shortHex(c.txHash, 8, 4)}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <footer
        style={{
          marginTop: 48,
          paddingTop: 16,
          borderTop: '1px solid #1a1a1a',
          fontSize: 12,
          color: '#888',
        }}
      >
        <p>
          Read-only dashboard. Reads <code>CallSettled</code> events directly from PactCore via the
          0G mainnet RPC — no indexer required. Auto-revalidates every 15 s.
        </p>
        <p>
          0G components used: <strong>0G Chain</strong> (PactCore contract + settle_batch txs),
          <strong> 0G Storage</strong> (per-call evidence rootHash in CallSettled),
          <strong> 0G Compute</strong> (insured via market-proxy-zerog).
        </p>
      </footer>
    </main>
  );
}
