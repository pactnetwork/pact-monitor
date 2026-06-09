# WP-MN-03b — Services Swap to SolanaAdapter (multi-network per service) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Swap settler.submitter + indexer.on-chain-sync + market-proxy.balance from direct `protocol-v1-client` + `wrap` usage to the `SolanaAdapter` interface via a `Map<network, ChainAdapter>` per service. Lands the multi-network-per-service topology Tu locked 2026-05-20.

**Architecture:** 5 tasks. T1 extends `SettleBatchInput` with `latencyMs`. T2 scaffolds `EvmAdapterStub`. T3 wires `PACT_ENABLED_NETWORKS` + `PACT_LEGACY_DIRECT_SOLANA` env config in all 3 services. T4 swaps the chain-touch call sites (the live-settler change). T5 ships the adapter-swap byte-identical e2e diff (the Gate B headline) + multi-network routing tests.

**Tech Stack:** TypeScript / NestJS / Vitest / pnpm workspaces.

**Branch:** `feat/multi-network-03b-services-swap` (off `feat/multi-network@ebb8664` post WP-MN-03a).

**Captain-proxy directives:**
- Atomic commits per task, conventional-commit prefixes.
- NO remote pushes until Gate B closes.
- **PACT_LEGACY_DIRECT_SOLANA=true** preserves rollback at deploy time.
- Pause-and-escalate on RESEARCH-contradicting findings.

**Source-of-truth references:**
- CONTEXT: `.planning/phases/mn-03b-services-swap/mn-03b-CONTEXT.md`
- RESEARCH: `.planning/phases/mn-03b-services-swap/mn-03b-RESEARCH.md` (esp. §2 chain-touch audit, §4 multi-network architecture, §5 RESEARCH decisions)

---

## Task 1: `SettleBatchInput.+latencyMs` additive interface change

**Goal:** Extend `SettleBatchInput.events[]` with required `latencyMs: number`. Update `SolanaAdapter` to read it instead of hardcoded 0. Update WP-MN-02's parity test.

**Files:**
- Modify: `packages/shared/src/chain-adapter.ts`
- Modify: `packages/shared/src/adapters/solana/index.ts`
- Modify: `packages/shared/test/solana-adapter-parity.test.ts`

- [ ] **Step 1: Edit `chain-adapter.ts`** — add `latencyMs: number` to `SettleBatchInput.events[]` tuple. Document: "Per-call latency in ms; written verbatim into the CallRecord. Not used for breach logic."

- [ ] **Step 2: Edit `adapters/solana/index.ts`** — find the per-event mapping in `submitSettleBatch`. The line `latencyMs: 0` (added in WP-MN-02 T3 critical fix). Replace with `latencyMs: e.latencyMs`. Remove the stale comment about the WP-MN-03b deferral.

- [ ] **Step 3: Update parity test** — `packages/shared/test/solana-adapter-parity.test.ts`. The existing `submitSettleBatch rejects undefined signer` test creates an empty events array — keep. Add a new test (or extend the existing one) that constructs a single event with `latencyMs: 42` and asserts the field flows through. Since `submitSettleBatch` rejects on signer, the test can use a stub signer + stub Connection to verify the call. Or simpler: assert that `SettleBatchInput.events[0].latencyMs` is `42` after construction — pure shape test, no broadcast.

- [ ] **Step 4: Verify**
```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm --filter @pact-network/shared test 2>&1 | tail -10
```
Expected: 17 baseline + 0–1 new = 17 or 18 green.

- [ ] **Step 5: Commit**
```bash
git add packages/shared/
git commit -m "feat(shared): SettleBatchInput.+latencyMs additive (WP-MN-03b T1)

Resolves WP-MN-02 carry-forward: SolanaAdapter previously
hardcoded latencyMs: 0 in the per-event CallRecord. Adds required
latencyMs: number to SettleBatchInput.events[] tuple; SolanaAdapter
reads from the input.

Additive interface change — forward-compatible. EvmAdapter (T2
stub + WP-MN-04 real impl) must also honor the field.

WP-MN-03b T4 plumbs the real latency from WrapCallEventDto through
the settler's batcher → adapter path."
```

---

## Task 2: `EvmAdapterStub` scaffold

**Goal:** Create a no-op `ChainAdapter` impl for EVM that throws on every method with a clear error. Lets services hold an Arc adapter in the Map without crashing at boot; routes to EVM are exercisable; tests confirm the routing without actually settling.

**Files:**
- Create: `packages/shared/src/adapters/evm/index.ts`
- Modify: `packages/shared/src/index.ts` (re-export)
- Create: `packages/shared/test/evm-adapter-stub.test.ts`

- [ ] **Step 1: Create `packages/shared/src/adapters/evm/index.ts`**:

```typescript
/**
 * EvmAdapterStub — placeholder ChainAdapter for EVM networks at WP-MN-03b
 * time. Every method throws `Error("EvmAdapter not implemented — WP-MN-04")`.
 * Exists so services can hold an EVM entry in their Map<network, ChainAdapter>
 * without crashing at boot; routes are exercisable; EVM settlement throws
 * loudly until WP-MN-04 lands the real EvmAdapter.
 */

import type {
  ChainAdapter,
  ChainDescriptor,
  EligibilityCheckResult,
  EndpointConfigSnapshot,
  SettleBatchInput,
  SettleBatchResult,
} from "../../chain-adapter";

const NOT_IMPLEMENTED = "EvmAdapter not implemented — WP-MN-04";

export interface EvmAdapterStubOptions {
  descriptor: ChainDescriptor;
}

export class EvmAdapterStub implements ChainAdapter {
  readonly descriptor: ChainDescriptor;

  constructor(opts: EvmAdapterStubOptions) {
    if (opts.descriptor.vm !== "evm") {
      throw new Error(
        `EvmAdapterStub requires descriptor.vm === "evm", got "${opts.descriptor.vm}"`,
      );
    }
    this.descriptor = opts.descriptor;
  }

  async readEndpointConfigs(): Promise<ReadonlyArray<EndpointConfigSnapshot>> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async submitSettleBatch(_: SettleBatchInput): Promise<SettleBatchResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async checkAgentEligibility(
    _: string,
    __: bigint,
  ): Promise<EligibilityCheckResult> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
```

- [ ] **Step 2: Re-export from `index.ts`**:
```typescript
export { EvmAdapterStub } from "./adapters/evm";
export type { EvmAdapterStubOptions } from "./adapters/evm";
```

- [ ] **Step 3: Test file** — `packages/shared/test/evm-adapter-stub.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { EvmAdapterStub, getChain } from "../src";

describe("EvmAdapterStub", () => {
  it("constructs with an EVM descriptor", () => {
    const stub = new EvmAdapterStub({ descriptor: getChain("arc-testnet") });
    expect(stub.descriptor.vm).toBe("evm");
    expect(stub.descriptor.network).toBe("arc-testnet");
  });

  it("rejects a Solana descriptor", () => {
    expect(
      () => new EvmAdapterStub({ descriptor: getChain("solana-devnet") }),
    ).toThrow(/requires descriptor.vm === "evm"/);
  });

  it("readEndpointConfigs throws not-implemented", async () => {
    const stub = new EvmAdapterStub({ descriptor: getChain("arc-testnet") });
    await expect(stub.readEndpointConfigs()).rejects.toThrow(/WP-MN-04/);
  });

  it("submitSettleBatch throws not-implemented", async () => {
    const stub = new EvmAdapterStub({ descriptor: getChain("arc-testnet") });
    await expect(
      stub.submitSettleBatch({
        slug: "test",
        signer: {},
        events: [],
      }),
    ).rejects.toThrow(/WP-MN-04/);
  });

  it("checkAgentEligibility throws not-implemented", async () => {
    const stub = new EvmAdapterStub({ descriptor: getChain("arc-testnet") });
    await expect(stub.checkAgentEligibility("0x", 100n)).rejects.toThrow(
      /WP-MN-04/,
    );
  });
});
```

- [ ] **Step 4: Verify + commit**
```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm --filter @pact-network/shared test 2>&1 | tail -10
git add packages/shared/
git commit -m "feat(shared): EvmAdapterStub for WP-MN-03b/04 boundary (WP-MN-03b T2)

Placeholder ChainAdapter for EVM networks. Every method throws
'EvmAdapter not implemented — WP-MN-04'. Lets services hold an
EVM entry in Map<network, ChainAdapter> without crashing at boot.

WP-MN-04 replaces the stub with the real EvmAdapter.

Test count: +5 in @pact-network/shared."
```

---

## Task 3: Service `Map<network, ChainAdapter>` bootstrap + env config

**Goal:** Each of the 3 services constructs a `Map<network, ChainAdapter>` at boot from `PACT_ENABLED_NETWORKS` env. Per-network signing key loaded for settler. `PACT_LEGACY_DIRECT_SOLANA` flag read + logged at startup. No swap of call sites yet — that's T4.

**Files:**
- Create: `packages/settler/src/adapters/adapters.module.ts`
- Create: `packages/settler/src/adapters/adapters.service.ts`
- Create: `packages/indexer/src/adapters/adapters.module.ts`
- Create: `packages/indexer/src/adapters/adapters.service.ts`
- Modify: `packages/market-proxy/src/lib/context.ts` (the proxy's bootstrap)
- Modify: `packages/{settler,indexer}/src/app.module.ts` (register AdaptersModule)
- Modify: `packages/{settler,indexer}/package.json` (add `@pact-network/shared` if missing)

- [ ] **Step 1: settler `AdaptersService`**

Create `packages/settler/src/adapters/adapters.service.ts`:

```typescript
import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ChainAdapter,
  EvmAdapterStub,
  SolanaAdapter,
  getChain,
} from "@pact-network/shared";
import { Keypair } from "@solana/web3.js";

@Injectable()
export class AdaptersService implements OnModuleInit {
  private readonly logger = new Logger(AdaptersService.name);
  private readonly adapters = new Map<string, ChainAdapter>();
  private readonly keypairs = new Map<string, Keypair>();
  readonly legacyDirectSolana: boolean;

  constructor(private readonly config: ConfigService) {
    this.legacyDirectSolana =
      this.config.get<string>("PACT_LEGACY_DIRECT_SOLANA") === "true";
  }

  onModuleInit(): void {
    const enabledRaw =
      this.config.get<string>("PACT_ENABLED_NETWORKS") ?? "solana-devnet";
    const enabled = enabledRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const name of enabled) {
      const descriptor = getChain(name); // throws on unknown

      if (descriptor.vm === "solana") {
        const rpcUrl = this.resolveRpcUrl(name);
        const adapter = new SolanaAdapter({ descriptor, rpcUrl });
        this.adapters.set(name, adapter);

        // Load signer (per-network env or shared SOLANA_KEYPAIR fallback)
        const kp = this.loadKeypair(name);
        if (kp) this.keypairs.set(name, kp);
      } else if (descriptor.vm === "evm") {
        this.adapters.set(name, new EvmAdapterStub({ descriptor }));
        // EVM signer wiring is WP-MN-04
      }
    }

    this.logger.log(
      `[settler] adapters bootstrapped: ${enabled.join(", ")} | legacyDirectSolana=${this.legacyDirectSolana}`,
    );
  }

  getAdapter(network: string): ChainAdapter {
    const a = this.adapters.get(network);
    if (!a) {
      throw new Error(
        `No adapter for network "${network}". Enabled: ${[...this.adapters.keys()].join(", ")}`,
      );
    }
    return a;
  }

  getSigner(network: string): Keypair {
    const kp = this.keypairs.get(network);
    if (!kp) {
      throw new Error(`No settler signer loaded for network "${network}"`);
    }
    return kp;
  }

  listEnabledNetworks(): string[] {
    return [...this.adapters.keys()];
  }

  private resolveRpcUrl(network: string): string {
    const envKey = `PACT_RPC_URL_${network.replace(/-/g, "_").toUpperCase()}`;
    return (
      this.config.get<string>(envKey) ??
      this.config.get<string>("SOLANA_RPC_URL") ??
      "https://api.devnet.solana.com"
    );
  }

  private loadKeypair(network: string): Keypair | null {
    // Per-network env first (PACT_SETTLER_KEYPAIR_<NETWORK>), then fallback
    // to legacy PACT_SETTLER_KEYPAIR for solana-devnet only.
    const perNetwork = this.config.get<string>(
      `PACT_SETTLER_KEYPAIR_${network.replace(/-/g, "_").toUpperCase()}`,
    );
    const fallback =
      network === "solana-devnet"
        ? this.config.get<string>("PACT_SETTLER_KEYPAIR")
        : undefined;
    const raw = perNetwork ?? fallback;
    if (!raw) return null;
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    } catch (e) {
      this.logger.warn(`Failed to parse keypair for ${network}: ${e}`);
      return null;
    }
  }
}
```

Create `packages/settler/src/adapters/adapters.module.ts`:

```typescript
import { Module } from "@nestjs/common";
import { AdaptersService } from "./adapters.service";

@Module({
  providers: [AdaptersService],
  exports: [AdaptersService],
})
export class AdaptersModule {}
```

- [ ] **Step 2: indexer `AdaptersService`** — same shape MINUS the `keypairs` map (indexer doesn't sign). Save at `packages/indexer/src/adapters/adapters.service.ts` and `adapters.module.ts`. The `resolveRpcUrl` is identical.

- [ ] **Step 3: market-proxy bootstrap**

The proxy doesn't use NestJS. Update `packages/market-proxy/src/lib/context.ts` to construct the adapter map alongside the existing balanceCheck. Add a `getAdapter(network)` helper to the context. Pattern:

```typescript
import { ChainAdapter, EvmAdapterStub, SolanaAdapter, getChain } from "@pact-network/shared";

export function buildAdapterMap(env: NodeJS.ProcessEnv): {
  adapters: Map<string, ChainAdapter>;
  legacyDirectSolana: boolean;
} {
  const adapters = new Map<string, ChainAdapter>();
  const legacyDirectSolana = env.PACT_LEGACY_DIRECT_SOLANA === "true";

  const enabled = (env.PACT_ENABLED_NETWORKS ?? "solana-devnet")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const name of enabled) {
    const descriptor = getChain(name);
    if (descriptor.vm === "solana") {
      const rpcUrl =
        env[`PACT_RPC_URL_${name.replace(/-/g, "_").toUpperCase()}`] ??
        env.SOLANA_RPC_URL ??
        "https://api.devnet.solana.com";
      adapters.set(name, new SolanaAdapter({ descriptor, rpcUrl }));
    } else if (descriptor.vm === "evm") {
      adapters.set(name, new EvmAdapterStub({ descriptor }));
    }
  }

  return { adapters, legacyDirectSolana };
}
```

Wire `buildAdapterMap(process.env)` into the existing context construction. Add an `adapters: Map<string, ChainAdapter>` and `legacyDirectSolana: boolean` field to whatever context object the proxy passes through.

- [ ] **Step 4: Register modules + wire deps**

- Edit `packages/settler/src/app.module.ts` — add `AdaptersModule` to imports. Confirm `@pact-network/shared` is in `packages/settler/package.json` deps; add if not.
- Edit `packages/indexer/src/app.module.ts` — same.
- For market-proxy, `@pact-network/shared` was added in WP-MN-03a T2; confirm.

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm install 2>&1 | tail -5
```

- [ ] **Step 5: Tests** — each service gets one new test asserting the AdaptersService/factory:
  - Default boot (no env): exactly 1 entry, `solana-devnet`, vm=solana.
  - `PACT_ENABLED_NETWORKS=solana-devnet,arc-testnet`: 2 entries, second is `EvmAdapterStub`.
  - `PACT_ENABLED_NETWORKS=bogus-chain`: throws via `getChain`.
  - `PACT_LEGACY_DIRECT_SOLANA=true`: flag captured + logged.

- [ ] **Step 6: Verify + commit**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm --filter @pact-network/settler test 2>&1 | tail -10
pnpm --filter @pact-network/indexer test 2>&1 | tail -10
pnpm --filter @pact-network/market-proxy test 2>&1 | tail -10
pnpm -r typecheck 2>&1 | tail -10
```

Expected: all green. Existing service tests preserved.

```bash
git add packages/{settler,indexer,market-proxy}/ pnpm-lock.yaml
git commit -m "feat(services): Map<network,ChainAdapter> bootstrap + env config (WP-MN-03b T3)

Adds AdaptersService/factory to settler, indexer, and market-proxy.
Each reads PACT_ENABLED_NETWORKS (default 'solana-devnet'),
constructs a Map<network, ChainAdapter> with SolanaAdapter for
solana-* and EvmAdapterStub for evm-* entries.

Settler also loads per-network signing keys: PACT_SETTLER_KEYPAIR_<NETWORK>
with PACT_SETTLER_KEYPAIR fallback for solana-devnet.

PACT_LEGACY_DIRECT_SOLANA flag captured + logged at startup. T4
wires the flag into the call sites.

Tests +12 (4 per service)."
```

---

## Task 4: Live-service swap — settler.submitter + indexer.on-chain-sync + market-proxy.balance

**Goal:** Replace direct `protocol-v1-client` + `wrap` chain-touch calls with adapter routing through the Map. Preserve the legacy direct path under `PACT_LEGACY_DIRECT_SOLANA=true`. This is the RISKIEST task.

**Files:**
- Modify: `packages/settler/src/submitter/submitter.service.ts` (the heavy lift)
- Modify: `packages/indexer/src/sync/on-chain-sync.service.ts`
- Modify: `packages/market-proxy/src/routes/proxy.ts` + `packages/market-proxy/src/lib/balance.ts`

### Settler swap (the live broadcast loop)

- [ ] **Step 1: Inject `AdaptersService` into `SubmitterService`**

Update the constructor to receive `AdaptersService`. Keep the existing `Connection`, `programId`, `usdcMint`, PDAs for the LEGACY PATH only; they're guarded by `adaptersService.legacyDirectSolana`.

- [ ] **Step 2: Refactor `submitBatch(batch)`**

Find the existing batch submit function. Pseudocode:
```typescript
async submitBatch(batch: SettleBatch) {
  const network = batch.events[0]?.network ?? "solana-devnet";
  if (this.adaptersService.legacyDirectSolana && network.startsWith("solana-")) {
    return this.submitBatchLegacyDirect(batch); // preserved pre-WP path
  }
  const adapter = this.adaptersService.getAdapter(network);
  const signer = this.adaptersService.getSigner(network);
  return this.submitBatchViaAdapter(batch, adapter, signer);
}

async submitBatchViaAdapter(batch, adapter, signer) {
  // Map batch.events → SettleBatchInput.events shape (with latencyMs from T1)
  const result = await adapter.submitSettleBatch({
    slug: batch.slug,
    signer,
    events: batch.events.map(e => ({
      callId: e.callId,
      agent: e.agentPubkey,
      premiumBaseUnits: BigInt(e.premiumLamports),
      outcome: e.outcome === "ok" ? "ok" : "breach",
      feeRecipientCountHint: e.feeRecipientCountHint ?? 0,
      latencyMs: e.latencyMs,  // T1 plumbing
    })),
  });
  return result;
}

async submitBatchLegacyDirect(batch) {
  // The existing pre-WP code lives here verbatim — moved into its own
  // method but unchanged. Reads this.connection, this.programId, etc.
}
```

The trick: the existing `submitBatch` is ~80 lines. Extract it to `submitBatchLegacyDirect` (no logic change) and add the adapter path alongside.

- [ ] **Step 3: Preserve `loadEndpoint` cache for legacy path only**

The settler's `loadEndpoint` + `endpointCache` only matter for the legacy direct path. The adapter path does its own load. Keep `loadEndpoint` private and call it only from `submitBatchLegacyDirect`.

- [ ] **Step 4: Update settler tests**

Existing tests likely use the legacy direct path (they predate the adapter). Either: (a) split tests into "legacy path" and "adapter path" suites, OR (b) parameterize over both modes. (a) is simpler — keep existing tests under `PACT_LEGACY_DIRECT_SOLANA=true` and add a parallel new suite for adapter mode.

### Indexer swap

- [ ] **Step 5: Refactor `on-chain-sync.service.ts`**

```typescript
@Cron(CronExpression.EVERY_5_MINUTES)
async refreshAllNetworks() {
  for (const network of this.adaptersService.listEnabledNetworks()) {
    if (this.adaptersService.legacyDirectSolana && network.startsWith("solana-")) {
      await this.refreshLegacyDirect(network);
    } else {
      await this.refreshViaAdapter(network);
    }
  }
}

async refreshViaAdapter(network: string) {
  const adapter = this.adaptersService.getAdapter(network);
  const snapshots = await adapter.readEndpointConfigs();
  for (const s of snapshots) {
    // s.raw is the SolanaAdapter's EndpointConfig struct — read flatPremiumLamports etc.
    const raw = s.raw as EndpointConfig; // per RESEARCH §3.1 carry-forward resolution
    await this.upsertEndpoint(network, s, raw);
  }
}

async refreshLegacyDirect(network: string) {
  // The existing pre-WP code lives here verbatim — getProgramAccounts +
  // decodeEndpointConfig. Network is hardcoded to "solana-devnet" since
  // legacy path only existed for that one.
}
```

- [ ] **Step 6: Update `upsertEndpoint` signature** to accept network as a parameter (not hardcoded `syncNetwork = "solana-devnet"`). Remove the `syncNetwork` constant entirely from the adapter path; legacy path keeps the hardcoded value for solana-devnet only.

### Market-proxy swap

- [ ] **Step 7: Refactor `lib/balance.ts`**

Replace `createBalanceCheck` with adapter-based eligibility OR keep it as a thin wrapper that the proxy calls based on the flag.

Pattern in `routes/proxy.ts:127` `wrapFetch({...})`:
```typescript
const endpoint = await loadEndpoint(slug); // already loaded; has endpoint.network now
const adapter = ctx.adapters.get(endpoint.network);
if (!adapter) {
  return c.text(`Network "${endpoint.network}" not enabled on this proxy`, 502);
}

const balanceCheck: BalanceCheck = ctx.legacyDirectSolana && endpoint.network.startsWith("solana-")
  ? createBalanceCheck({...legacyOpts}) // existing path
  : { check: (wallet, amt) => adapter.checkAgentEligibility(wallet, amt).then(toWrapShape) };

const result = await wrapFetch({
  // ...
  balanceCheck,
  network: endpoint.network,  // replaces the hardcoded getChain("solana-devnet").network
});
```

The `toWrapShape` adapter→wrap converter: our `EligibilityCheckResult` differs slightly from wrap's `BalanceCheckResult` (we use `no_account` reason where wrap uses `no_ata`). Convert.

### Verify + commit

- [ ] **Step 8:**
```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm -r typecheck 2>&1 | tail -10
pnpm --filter @pact-network/settler test 2>&1 | tail -10
pnpm --filter @pact-network/indexer test 2>&1 | tail -10
pnpm --filter @pact-network/market-proxy test 2>&1 | tail -10
```

All green or fixable. If a test breaks because the mocked Prisma/Connection setup was tightly bound to the legacy path, adapt the test to use `PACT_LEGACY_DIRECT_SOLANA=true` for legacy-compat tests + write parallel adapter-path tests in T5.

- [ ] **Step 9: Commit**
```bash
git add packages/{settler,indexer,market-proxy}/
git commit -m "feat(services): swap chain-touch to SolanaAdapter (WP-MN-03b T4)

THE LIVE-SERVICE SWAP. Three services now route chain-touch through
Map<network, ChainAdapter> from AdaptersService:

- settler.submitter: submitBatch routes by event.network to
  adapter.submitSettleBatch. Legacy direct path preserved in
  submitBatchLegacyDirect, gated by PACT_LEGACY_DIRECT_SOLANA=true.

- indexer.on-chain-sync: cron iterates listEnabledNetworks() and
  calls adapter.readEndpointConfigs() per network. Legacy direct
  path preserved under the flag.

- market-proxy: per-request adapter lookup by endpoint.network;
  adapter.checkAgentEligibility wired through wrap as a BalanceCheck.
  Legacy createBalanceCheck preserved under the flag.

Removes hardcoded 'solana-devnet' literal at proxy.ts:137 and
on-chain-sync.service.ts:210 (both eliminated by the routing).

Settler keeps loadEndpoint cache for legacy path only; adapter
path does its own load.

The adapter-swap byte-identical e2e diff lands at T5 — the Gate B
gate."
```

---

## Task 5: Adapter-swap byte-identical e2e diff + multi-network routing tests

**Goal:** Ship the Gate B headline artifact (byte-identical diff between legacy and adapter modes for solana-devnet) + multi-network routing tests proving Map dispatch works.

**Files:**
- Create: `packages/settler/test/adapter-swap-e2e.spec.ts`
- Create: `packages/indexer/test/adapter-swap-indexer.spec.ts`
- Create: `packages/market-proxy/test/multi-network-routing.spec.ts`

- [ ] **Step 1: Settler adapter-swap e2e**

Create `packages/settler/test/adapter-swap-e2e.spec.ts`. Test pattern:

```typescript
describe("WP-MN-03b — adapter-swap byte-identical (solana-devnet)", () => {
  const fixtureBatch = {
    slug: "test-endpoint",
    events: [
      // 2-3 representative events with known callIds, agents, premiums, outcomes
    ],
  };

  it("legacy direct path === adapter path for the same batch", async () => {
    // Run twice with a deterministic stub Connection that captures the
    // broadcast wire bytes. Same Keypair both times. Same PDA derivations.
    
    process.env.PACT_LEGACY_DIRECT_SOLANA = "true";
    const legacyResult = await runSettlerBatch(fixtureBatch);
    
    process.env.PACT_LEGACY_DIRECT_SOLANA = "false";
    const adapterResult = await runSettlerBatch(fixtureBatch);
    
    // The wire-bytes (transaction serialization) must be identical
    expect(adapterResult.wireBytesHex).toBe(legacyResult.wireBytesHex);
    expect(adapterResult.signature).toBe(legacyResult.signature);
    
    // The per-event share computation (off-chain pre-image) must be identical
    expect(adapterResult.shares).toEqual(legacyResult.shares);
  });
});
```

The `runSettlerBatch` helper sets up a `SubmitterService` with stub `Connection` (capturing `sendTransaction` calls) + stub `AdaptersService` returning a `SolanaAdapter` with the same stub Connection. Both modes share the stub, so the tx bytes are deterministic.

NOTE: If the existing settler test infrastructure already has a stub Connection (`submitter.service.spec.ts` likely does), reuse the helper.

- [ ] **Step 2: Indexer adapter-swap parity**

Create `packages/indexer/test/adapter-swap-indexer.spec.ts`:
- Seed local docker postgres with 1 EndpointConfig fixture.
- Run `refreshAllNetworks` under `PACT_LEGACY_DIRECT_SOLANA=true`; capture upserted DB state.
- Reset; run again under `PACT_LEGACY_DIRECT_SOLANA=false`; capture.
- Diff DB state — should be identical.

- [ ] **Step 3: Multi-network routing test**

Create `packages/market-proxy/test/multi-network-routing.spec.ts`:
- Boot with `PACT_ENABLED_NETWORKS=solana-devnet,arc-testnet`.
- Seed two endpoints: one `network='solana-devnet'`, one `network='arc-testnet'`.
- Request to solana-devnet endpoint → adapter path goes through SolanaAdapter.
- Request to arc-testnet endpoint → adapter path goes through EvmAdapterStub → 502 with "not implemented" body.
- Request to an endpoint whose network isn't enabled → 502.

- [ ] **Step 4: Verify + commit**

```bash
cd /Users/q3labsadmin/Q3/Solder/pact-network
pnpm -r test 2>&1 | tail -15
```

All green. Adapter-swap diff EMPTY. Multi-network routing exercises both modes.

```bash
git add packages/{settler,indexer,market-proxy}/test/
git commit -m "test(services): adapter-swap byte-identical e2e + multi-network routing (WP-MN-03b T5)

THE GATE B HEADLINE ARTIFACT.

settler/adapter-swap-e2e.spec.ts: for solana-devnet, the legacy
direct path and the adapter path produce byte-identical:
- transaction wire bytes
- signature (deterministic stub Connection)
- per-event share computation

Diff is EMPTY. Gate B BLOCKER if non-empty.

indexer/adapter-swap-indexer.spec.ts: same diff for readEndpointConfigs.

market-proxy/multi-network-routing.spec.ts: confirms Map dispatch
routes by endpoint.network; EvmAdapterStub returns 502 'not
implemented'; unknown network returns 502.

WP-MN-03b implementation complete."
```

---

## After all tasks

Gate B request: `mn-03b-REPORT-gateB.md` covering the 7-cat template plus the byte-identical e2e diff result (must be EMPTY).

Captain-proxy Gate B verdict → tag `pre-mn-04-rollback` on `feat/multi-network` post-merge.

Open PR vs `feat/multi-network`, merge with merge-commit. Update cockpit handoff. Proceed to WP-MN-04 (EvmAdapter + Arc fleet testnet).
