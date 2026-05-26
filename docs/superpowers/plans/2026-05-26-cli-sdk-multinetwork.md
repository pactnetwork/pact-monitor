# CLI + SDK Multi-Network Support (X-Pact-Network Header)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `--network` flag to the Pact CLI and `network` option to the Pact SDK so agents can disambiguate same-slug endpoints across chains via the `X-Pact-Network` header.

**Architecture:** Both the CLI (`signedRequest`) and SDK (`buildAuthHeaders`) construct `x-pact-*` header sets before sending proxied requests. We thread an optional `network` value through the call chain — from CLI flags / SDK config → transport auth builder → `X-Pact-Network` header. The SDK slug-resolver also exposes the `network` from the discovery response so automatic resolution works.

**Tech Stack:** TypeScript, Node, Commander (CLI)

---

### Task 1: CLI — Add `--network` option + forward as header

**Files:**
- Modify: `packages/cli/src/lib/transport.ts:36-105`
- Modify: `packages/cli/src/cmd/run.ts:9-110`
- Modify: `packages/cli/src/index.ts:156-252`

- [ ] **Step 1: Add `network` to `signedRequest` opts**

In `packages/cli/src/lib/transport.ts`, add `network?: string` to the `signedRequest` opts type and inject the header:

```typescript
interface SignedRequestOpts {
  gatewayUrl: string;
  slug: string;
  upstreamPath: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  keypair: Keypair;
  project: string;
  network?: string;               // NEW
  timeoutMs?: number;
  maxRetries?: number;
}
```

Then in the `allHeaders` object (around line 95), add:

```typescript
const allHeaders = {
  ...(userSetAcceptEncoding ? {} : { "accept-encoding": "identity;q=1, *;q=0" }),
  ...cleanedHeaders,
  "x-pact-agent": opts.keypair.publicKey.toBase58(),
  "x-pact-timestamp": String(ts),
  "x-pact-nonce": nonce,
  "x-pact-signature": bs58.encode(sig),
  "x-pact-project": opts.project,
  ...(opts.network ? { "x-pact-network": opts.network } : {}),
};
```

- [ ] **Step 2: Add `network` to `RunOpts`**

In `packages/cli/src/cmd/run.ts`, add `network?: string` to the `RunOpts` interface:

```typescript
export interface RunOpts {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  configDir: string;
  gatewayUrl: string;
  project: string;
  network?: string;    // NEW
  rpcUrl?: string;
  raw?: boolean;
  skipBalanceCheck?: boolean;
  timeoutMs?: number;
  getBalanceLamports?: (pubkey: PublicKey) => Promise<bigint>;
}
```

- [ ] **Step 3: Pass `network` to `signedRequest`**

In `packages/cli/src/cmd/run.ts` around line 110, where `signedRequest` is called, add `network`:

```typescript
const result = await signedRequest({
  gatewayUrl: opts.gatewayUrl,
  slug,
  upstreamPath,
  method: opts.method,
  body: opts.body,
  headers: opts.headers,
  keypair,
  project: opts.project,
  network: opts.network,    // NEW
});
```

- [ ] **Step 4: Add `--network` option to CLI**

In `packages/cli/src/index.ts`, add the `--network` option alongside the other global options (around line 170):

```typescript
.option("--network <name>", "Target network (e.g. base-sepolia, arc-testnet). Disambiguates same-slug endpoints across chains. Sent as X-Pact-Network header.")
```

Then pass it to `runCommand` in the handler (around line 240):

```typescript
network: options.network as string | undefined,
```

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lib/transport.ts packages/cli/src/cmd/run.ts packages/cli/src/index.ts
git commit -m "feat(cli): add --network flag + x-pact-network header"
```

---

### Task 2: SDK — Add `network` to `PactConfig` + thread through golden-fetch

**Files:**
- Modify: `packages/sdk/src/config.ts:30-98`
- Modify: `packages/sdk/src/proxy-transport.ts:85-113`
- Modify: `packages/sdk/src/golden-fetch.ts:53-102`

- [ ] **Step 1: Add optional `network` to `PactConfig` and `ResolvedConfig`**

In `packages/sdk/src/config.ts`:

```typescript
export interface PactConfig {
  network: Network;
  signer: PactSigner;
  apiKey?: string;
  signRequests?: boolean;
  requestSigningSecretKey?: Uint8Array;
  programId?: string;
  usdcMint?: string;
  rpcUrl?: string;
  proxyBaseUrl?: string;
  indexerBaseUrl?: string;
  defaultAllowanceUsdc?: number;
  autoTopUp?: AutoTopUpConfig;
  project?: string;
  network?: string;              // NEW — endpoint network override (e.g. "base-sepolia")
  storagePath?: string;
  storage?: PactStorage;
  indexerPollIntervalMs?: number;
  installSignalHandlers?: boolean;
  latencyThresholdMs?: number;
  webhook?: WebhookConfig;
  fetchImpl?: typeof fetch;
}
```

And in the `ResolvedConfig` interface:

```typescript
export interface ResolvedConfig {
  network: Network;
  signer: PactSigner;
  project: string;
  network?: string;    // NEW — same optional override
  // ... rest unchanged
}
```

In `validateConfig()`, pass `network` through to `ResolvedConfig` unchanged.

- [ ] **Step 2: Add `network` to `AuthHeaderInput`**

In `packages/sdk/src/proxy-transport.ts`, add to the input interface:

```typescript
interface AuthHeaderInput {
  agentPubkey: string;
  secretKey: Uint8Array;
  project: string;
  network?: string;    // NEW
  method: string;
  path: string;
  bodyBytes: Uint8Array | null;
}
```

In the return object of `buildAuthHeaders()`, add:

```typescript
return {
  "x-pact-agent": input.agentPubkey,
  "x-pact-timestamp": String(ts),
  "x-pact-nonce": nonce,
  "x-pact-signature": bs58.encode(sig),
  "x-pact-project": input.project,
  ...(input.network ? { "x-pact-network": input.network } : {}),
};
```

- [ ] **Step 3: Thread `network` through `GoldenFetchDeps`**

In `packages/sdk/src/golden-fetch.ts`, add `network?: string` to `GoldenFetchDeps`:

```typescript
export interface GoldenFetchDeps {
  resolver: SlugResolver;
  proxyBaseUrl: string;
  project: string;
  network?: string;    // NEW
  signRequests: boolean;
  agentPubkey: string;
  secretKey: Uint8Array | null;
  fetchImpl: typeof fetch;
  now?: () => number;
}
```

Then in the `goldenFetch` function, where `buildAuthHeaders` is called (around line 102), pass `network`:

```typescript
const authHeaders = deps.signRequests
  ? await buildAuthHeaders({
      agentPubkey: deps.agentPubkey,
      secretKey: deps.secretKey,
      project: deps.project,
      network: deps.network,    // NEW
      method: init?.method ?? "GET",
      path: proxiedPath,
      bodyBytes,
    })
  : {};
```

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/config.ts packages/sdk/src/proxy-transport.ts packages/sdk/src/golden-fetch.ts
git commit -m "feat(sdk): add network config option + x-pact-network header"
```

---

### Task 3: SDK — Wire network from config through factory

**Files:**
- Modify: `packages/sdk/src/factory.ts:111-236`

- [ ] **Step 1: Pass network into `GoldenFetchDeps`**

In `packages/sdk/src/factory.ts`, in `createPact()`, where `GoldenFetchDeps` is constructed (around line 236), add `network`:

```typescript
const goldenDeps: GoldenFetchDeps = {
  resolver,
  proxyBaseUrl: net.proxyBaseUrl,
  project: cfg.project,
  network: cfg.network,    // NEW — from config override
  signRequests: cfg.signRequests,
  agentPubkey,
  secretKey,
  fetchImpl: cfg.fetchImpl ?? globalThis.fetch,
};
```

- [ ] **Step 2: Commit**

```bash
git add packages/sdk/src/factory.ts
git commit -m "feat(sdk): wire endpoint network from config through golden-fetch"
```

---

### Task 4: SDK — Expose network from slug-resolver discovery

**Files:**
- Modify: `packages/sdk/src/slug-resolver.ts:10-50`

- [ ] **Step 1: Add `network` to resolved entry type and pass through**

The discovery response now includes `network` per endpoint. The `DiscoveryEndpoint` type in the proxy already exposes it. The `SlugResolver` needs to include it in its resolved entry.

In `packages/sdk/src/slug-resolver.ts`, find the resolved entry type (likely an interface/type for the cache entry) and add `network?: string`. Then when `resolve()` returns an entry, include the network from the raw discovery row.

The specific location depends on how the resolver's cache stores entries. Look for the type that maps cached entries (likely around line 15-30) — it stores `slug`, `premiumBps`, `paused` from the discovery row. Add `network` there and propagate it through the `resolve()` return value.

- [ ] **Step 2: Commit**

```bash
git add packages/sdk/src/slug-resolver.ts
git commit -m "feat(sdk): expose network from discovery in slug-resolver"
```
