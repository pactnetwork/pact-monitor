# WP-MN-02 — RESEARCH

- **Purpose:** Gate A entry artifact. Maps every service-side `protocol-v1-client` + `wrap` call site to a `ChainAdapter` method, locks the interface shape and dep direction, and breaks WP-MN-02 into sub-task PLAN files.
- **Companion:** `mn-02-CONTEXT.md`
- **Branch:** `feat/multi-network-02-chain-adapter` off `feat/multi-network@5a35c02`
- **Date:** 2026-05-20

---

## 1. Architecture-spec reference quotes

From `docs/evm/2026-05-19-multi-network-architecture-spec.md`:

- **§3 L2 (ChainAdapter):** "Per-VM adapter implementations behind one `ChainAdapter` interface. Service code holds an `adapter: ChainAdapter` — not a `Connection` and not an `ethers.Provider`. **REV1:** the symmetric `watch(fromBlockOrSlot)` seam was removed; the per-call path is PUSH (settler → POST /events → indexer). The adapter exposes `readEndpointConfigs()` for the 5-min EndpointConfig refresh and an optional `tailSettlementEvents?()` for chains without a settler-side push."
- **§11 D2:** "DECIDED: `@pact-network/shared`/`core` owns it; the SDK consumes it." Locks the registry owner.
- **§11 D5:** "DECIDED: precondition of SDK M0." WP-MN-05 (Ken's SDK `core`) consumes the interface defined here.

From off-chain spec §5 (REV1): the indexer's `on-chain-sync` module is **only** the EndpointConfig refresh path; the per-call indexing path is PUSH via `POST /events`. WP-MN-02's adapter interface must reflect this — no per-call PULL seam.

---

## 2. Service-side client call-site audit

### 2.1 `packages/settler/src/submitter/submitter.service.ts`

`@pact-network/protocol-v1-client` imports at lines 49–69 (per `grep`):
- `sendAndConfirmTransaction` from `@solana/web3.js` (not the client, but the broadcast primitive)
- `buildSettleBatchIx` — settle-batch instruction builder
- `decodeCoveragePool`, `decodeEndpointConfig` — state decoders
- `getCoveragePoolPda`, `getEndpointConfigPda`, `getProtocolConfigPda`, `getSettlementAuthorityPda`, `getTreasuryPda` — PDA derivers
- `slugBytes` — slug normalizer
- `USDC_MINT_DEVNET` — chain-specific constant
- `type SettlementEvent as ChainSettlementEvent` — type re-import

Concrete call sites the adapter must subsume:
- L144–146: bulk PDA derivations at boot (`settlementAuthorityPda`, `treasuryPda`, `protocolConfigPda`).
- L235: `slugBytes(slug)` per-event.
- L247: `buildSettleBatchIx(...)` constructs the on-chain ix.
- L286: `sendAndConfirmTransaction(this.connection, tx, [keypair], opts)` — broadcast.
- L334–335: per-slug PDA derivation (`slugBytes`, `getEndpointConfigPda`, `getCoveragePoolPda`).
- L339–340: `connection.getAccountInfo` for EndpointConfig + CoveragePool.
- L348–349: `decodeEndpointConfig(...)`, `decodeCoveragePool(...)`.
- L362: `connection.getAccountInfo` (likely CallRecord — used in retry/lookup).
- L473–475: `connection.getAccountInfo` + `connection.getSignaturesForAddress` (CallRecord + history).

### 2.2 `packages/indexer/src/sync/on-chain-sync.service.ts`

`@pact-network/protocol-v1-client` imports at L9–12:
- `decodeEndpointConfig`, `EndpointConfig` (type), `ENDPOINT_CONFIG_LEN`, `PROGRAM_ID`.

Concrete call sites:
- L161–162: `connection.getProgramAccounts(programId, { filters: [{ dataSize: ENDPOINT_CONFIG_LEN }] })` — fetch every EndpointConfig PDA. Runs every 5 min via `@Cron`.
- L177: `decodeEndpointConfig(acct.account.data)` — per-result decode.

### 2.3 `packages/market-proxy/src/lib/balance.ts`

**Does NOT depend on `@pact-network/protocol-v1-client`.** Uses `@pact-network/wrap` `createDefaultBalanceCheck` (from `packages/wrap/src/balanceCheck.ts`) which speaks plain Solana JSON-RPC via `fetch` (no SDK dep in the hot path). A lazy production resolver in `balance.ts:58–69` uses `@solana/web3.js` + `@solana/spl-token` to compute the ATA.

The `BalanceCheckResult` shape (`packages/wrap/src/balanceCheck.ts:18–25`) is `{ eligible: true, ataBalance, allowance } | { eligible: false, reason, ataBalance?, allowance? }` with reasons `insufficient_balance | insufficient_allowance | no_ata`.

### 2.4 Sanity — what's NOT touched

- `packages/wrap/src/*` — wrap is the cross-VM HTTP-wrap library; it stays VM-agnostic by design. The adapter consumes wrap's `BalanceCheck` interface, not the other way around.
- `packages/sdk/src/*` — uses `protocol-v1-client` indirectly via the API endpoints exposed by the proxy/indexer; no direct chain touch.
- `packages/cli/src/*` — has `@pact-network/protocol-v1-client` dep but it's an admin CLI, out of WP-MN-02 scope (services first; CLI follows in a later WP if needed).
- `packages/market-dashboard/src/*` — Next.js client, uses `@solana/wallet-adapter-react`; dashboard is §5a (out of WP-MN-02 scope).

---

## 3. Workspace dep-graph audit (cycle prevention)

| Package | Depends on | Depended on by |
|---|---|---|
| `@pact-network/shared` | (none currently — only `typescript` devDep) | **none currently** |
| `@pact-network/protocol-v1-client` | `@solana/web3.js` | `cli`, `indexer`, `market-dashboard`, `settler` |
| `@pact-network/wrap` | (none — peerDep only on `@google-cloud/pubsub`) | `facilitator`, `market-proxy`, `settler` |
| `@solana/web3.js` (3rd-party) | — | `protocol-v1-client`, `market-proxy` (lazy via balance.ts) |
| `@solana/spl-token` (3rd-party) | — | `market-proxy` (lazy via balance.ts) |

**No cycle risk.** Shared has zero current consumers, so it can take a dep on protocol-v1-client + wrap without creating a back-edge. WP-MN-02 adds those deps to shared; WP-MN-03b adds `@pact-network/shared` to `settler`, `indexer`, `market-proxy` package.json files.

---

## 4. Interface design — `ChainAdapter`

### 4.1 Surface (locked by this RESEARCH)

```typescript
// packages/shared/src/chain-adapter.ts

export type ChainVm = "solana" | "evm";

export interface ChainDescriptor {
  /** Virtual machine family. */
  vm: ChainVm;
  /** Network identifier — value of `event.network` in SettlementEvent (WP-MN-03a). */
  network: string;             // "solana-devnet" | "arc-testnet" | ...
  /** EVM chain id (omitted for Solana). */
  chainId?: number;
  /** USDC token address (Solana mint base58 / EVM contract 0x-hex). */
  usdcMint: string;
  /** USDC decimals (must equal ProtocolInvariants.EXPECTED_USDC_DECIMALS = 6). */
  usdcDecimals: number;
}

/** Snapshot of an on-chain EndpointConfig for one slug. VM-agnostic shape. */
export interface EndpointConfigSnapshot {
  slug: string;
  authority: string;           // base58 (Solana) or 0x-hex (EVM)
  maxTotalFeeBps: number;
  feeRecipients: ReadonlyArray<{ recipient: string; bps: number; kind: number }>;
  paused: boolean;
  /** VM-specific opaque blob (decoded protocol struct) — adapters may put extra fields here. */
  raw: unknown;
}

/** Inputs to a settle_batch / settleBatch call. */
export interface SettleBatchInput {
  /** Slug being settled. */
  slug: string;
  /** Settler-authority signing key (Solana: Keypair; EVM: bytes of private key). */
  signer: unknown;              // adapter-specific shape; not narrowed at interface
  /** Per-call events. Wire-format identical to wrap.SettlementEvent (T-MN-03a adds `network`). */
  events: ReadonlyArray<{
    callId: string;
    agent: string;
    premiumBaseUnits: bigint;
    outcome: "ok" | "breach";
    feeRecipientCountHint: number;
  }>;
  /** Optional commitment / confirmation knobs. */
  options?: { commitment?: "confirmed" | "finalized"; skipPreflight?: boolean };
}

export interface SettleBatchResult {
  /** On-chain transaction identifier (signature on Solana, txHash on EVM). */
  txId: string;
  /** Per-event outcome from the protocol's view (settled / replayed / rejected). */
  perEvent: ReadonlyArray<{ callId: string; status: "settled" | "replayed" | "rejected"; reason?: string }>;
}

export type EligibilityRejectionReason =
  | "insufficient_balance"
  | "insufficient_allowance"
  | "no_account";

export type EligibilityCheckResult =
  | { eligible: true; balance: bigint; allowance: bigint }
  | { eligible: false; reason: EligibilityRejectionReason; balance?: bigint; allowance?: bigint };

/** Optional tail interface for chains without a settler-side PUSH. Not used by Solana. */
export interface TailOptions {
  fromBlockOrSlot: string;
  pollIntervalMs?: number;
}

export interface ChainAdapter {
  /** Static descriptor. */
  readonly descriptor: ChainDescriptor;

  /** Used by indexer.on-chain-sync (5-min EndpointConfig refresh). */
  readEndpointConfigs(): Promise<ReadonlyArray<EndpointConfigSnapshot>>;

  /** Used by settler.submitter (the only chain-write path in services). */
  submitSettleBatch(input: SettleBatchInput): Promise<SettleBatchResult>;

  /** Used by market-proxy.balance (per-call eligibility check, hot path). */
  checkAgentEligibility(agent: string, requiredBaseUnits: bigint): Promise<EligibilityCheckResult>;

  /** Optional per-call tail — only chains without a settler push implement this.
   *  PUSH model (Solana + Arc + future EVM) leaves this undefined. */
  tailSettlementEvents?(opts: TailOptions): AsyncIterable<{
    callId: string;
    settlementSig: string;
    blockOrSlot: string;
  }>;
}
```

### 4.2 Why this shape, not a richer one

- **Single hot path per service:** settler writes settle-batch (`submitSettleBatch`); indexer reads endpoint configs (`readEndpointConfigs`); market-proxy reads eligibility (`checkAgentEligibility`). Three methods cover 100% of the today-used surface.
- **No PDA-deriver exposure:** the PDA derivation is internal to `SolanaAdapter`. Services that today call `getEndpointConfigPda` etc. directly will call `adapter.readEndpointConfigs()` / pass the slug to higher-level methods instead. This is the WP-MN-03b refactor target; WP-MN-02 just makes the API available.
- **`signer: unknown` in SettleBatchInput:** the signing key shape is irreducibly VM-specific (Solana `Keypair` vs EVM private-key hex). The adapter narrows the type at impl boundary; service callers pass the same shape they hold today.
- **`raw: unknown` in EndpointConfigSnapshot:** for cases where the indexer needs a field not in the VM-agnostic projection (e.g., a Solana-specific PDA bump), it can dip into `raw`. EVM impls populate this with their own decoded struct. WP-MN-03b only needs the projected fields.
- **No `getCallRecord` / `getSignatureHistory`:** settler today has retry/lookup helpers that hit `connection.getAccountInfo(callRecordPda)` + `getSignaturesForAddress`. These are NOT in the WP-MN-02 hot path; they stay inside the SolanaAdapter as private helpers (not on the interface). If EvmAdapter needs an equivalent, WP-MN-04 RESEARCH can ADD a method (purely additive — interface evolves by addition, not by reshape).

### 4.3 No `watch()` symmetric seam (REV1 enforcement)

The interface deliberately omits a `watch(fromBlockOrSlot)` method. Per off-chain spec §5 (REV1):
- Per-call ingestion is PUSH: settler emits `POST /events` to indexer.
- `on-chain-sync` is ONLY the 5-min EndpointConfig refresh (`readEndpointConfigs()`).
- `tailSettlementEvents?()` is optional and unused on production chains; it's a forward-compat hook for chains that lack a settler-side push.

WP-MN-04's EvmAdapter does NOT implement `tailSettlementEvents` (Arc has a settler push; PUSH model holds).

---

## 5. RESEARCH-time decisions (ratified at Gate A)

### 5.1 SolanaAdapter location

**Decision:** `packages/shared/src/adapters/solana/` (co-located with interface).

**Rationale:**
- WP-MN-04's EvmAdapter will land in `packages/shared/src/adapters/evm/` for symmetry.
- Shared has zero current consumers; adding the deps doesn't burden any package not already pulling in `@solana/web3.js`.
- D2 says "shared owns the registry; the SDK consumes it" — putting adapters in shared makes shared the central hub for VM-agnostic concerns.
- Avoids creating a new `@pact-network/chain-adapters` package — the WP-EVM precedent is to grow within existing packages rather than spawn new ones casually.

**Considered and rejected:** putting SolanaAdapter in `@pact-network/protocol-v1-client/src/adapter.ts`. Rejected because (a) it creates a circular concept (the client is wrapped BY the adapter, the adapter shouldn't live IN the client), and (b) symmetry with EvmAdapter would force EvmAdapter into `protocol-evm-v1-client`, splitting the per-VM adapter implementations across two packages instead of one.

### 5.2 Dep direction

`@pact-network/shared` gains:

```json
"dependencies": {
  "@pact-network/protocol-v1-client": "workspace:*",
  "@pact-network/wrap": "workspace:*",
  "@solana/web3.js": "^1.95.8",
  "@solana/spl-token": "^0.4.0"
}
```

`@solana/web3.js` is needed for the `Connection` + `Keypair` + `Transaction` types and `sendAndConfirmTransaction` (currently used directly by `settler/submitter.service.ts`; SolanaAdapter pulls this in so it can do the broadcast). `@solana/spl-token` is needed for the ATA derivation currently in `market-proxy/lib/balance.ts:62–67`. Workspace deps on protocol-v1-client + wrap are the workspace-internal hubs.

No cycle: protocol-v1-client + wrap do not depend on shared.

### 5.3 Solana network registry entry

`chains.ts` in shared exposes a unified `getChain(name)` helper. The Solana entry is hand-coded (not in `config/chains.json` per WP-MN-01 RESEARCH §5.3 — that file is Foundry-scoped):

```typescript
// packages/shared/src/chains.ts
import evmChains from "../../program-evm/protocol-evm-v1/config/chains.json" with { type: "json" };
// Fallback for ts/test envs: readFileSync (same pattern as protocol-evm-v1-client/src/constants.ts post-WP-MN-01 T2).

import { USDC_MINT_DEVNET, USDC_MINT_MAINNET } from "@pact-network/protocol-v1-client";

const solanaChains: Record<string, ChainDescriptor> = {
  "solana-devnet": {
    vm: "solana",
    network: "solana-devnet",
    usdcMint: USDC_MINT_DEVNET.toBase58(),
    usdcDecimals: 6,
  },
  "solana-mainnet": {
    vm: "solana",
    network: "solana-mainnet",
    usdcMint: USDC_MINT_MAINNET.toBase58(),
    usdcDecimals: 6,
  },
};

const evmChainEntries: Record<string, ChainDescriptor> = Object.fromEntries(
  Object.entries(evmChains).map(([name, c]) => [name, {
    vm: "evm",
    network: name,
    chainId: (c as any).chainId,
    usdcMint: (c as any).usdcAddress,
    usdcDecimals: (c as any).usdcDecimals,
  }])
);

const REGISTRY: Record<string, ChainDescriptor> = { ...solanaChains, ...evmChainEntries };

export function getChain(name: string): ChainDescriptor { /* throw on unknown */ }
export function listChains(): ReadonlyArray<ChainDescriptor> { /* values */ }
```

### 5.4 Parity-test strategy (offline, byte-identical proof)

For each `SolanaAdapter` method, the parity test:
1. Constructs a fixed input (slug, events, options).
2. Computes the expected output by running the **same path the current service code runs** — i.e. directly calling `buildSettleBatchIx`, `getEndpointConfigPda` + `connection.getAccountInfo`, `wrap.createDefaultBalanceCheck`, etc. With injected fake RPC + fake fetch.
3. Computes the actual output by calling the adapter method with the same input + same injected dependencies.
4. Asserts `expected === actual` byte-for-byte (transaction wire bytes, decoded struct shape, eligibility result shape).

The injected fixtures:
- `Connection` → an in-memory stub (already used in `submitter.service.spec.ts` per the existing test infrastructure).
- `fetch` → MSW or a hand-rolled stub returning canned JSON-RPC responses (already used in `wrap/balanceCheck.test.ts`).

No live RPC, no devnet network. CI-safe.

### 5.5 Interface-shape contract test

`packages/shared/test/chain-adapter-contract.test.ts` — generic TypeScript-compile-time + runtime test that any implementer of `ChainAdapter` must pass. Asserts:
- `descriptor.vm` is a `ChainVm` value.
- `readEndpointConfigs()` resolves to a `ReadonlyArray<EndpointConfigSnapshot>`-shaped value.
- `submitSettleBatch(stubInput)` resolves to a `SettleBatchResult`-shaped value.
- `checkAgentEligibility("addr", 100n)` resolves to an `EligibilityCheckResult`-shaped value.
- `tailSettlementEvents` is either undefined or an `AsyncIterable`.

WP-MN-04's EvmAdapter re-runs the same suite (parameterized by adapter instance).

---

## 6. Sub-task breakdown (PLAN files)

| PLAN | Title | Files touched | Tests |
|---|---|---|---|
| `mn-02-01-PLAN.md` | Interface + types | Create `packages/shared/src/chain-adapter.ts` (interface + 6 types). Update `packages/shared/src/index.ts` to re-export. | Type-check passes; new interface compiles in isolation. |
| `mn-02-02-PLAN.md` | chains.ts registry (D2 owner) | Create `packages/shared/src/chains.ts`. Update package.json: add `@pact-network/protocol-v1-client` workspace dep (registry consumes USDC_MINT_DEVNET/MAINNET). Re-export from index.ts. | New unit test asserts arc-testnet entry resolves from chains.json + solana-devnet entry resolves from hand-coded source + getChain throws on unknown. |
| `mn-02-03-PLAN.md` | SolanaAdapter passthrough impl | Create `packages/shared/src/adapters/solana/index.ts` with `SolanaAdapter implements ChainAdapter`. Update package.json: add `@pact-network/wrap` workspace dep + `@solana/web3.js` + `@solana/spl-token`. Re-export from index.ts. | SolanaAdapter compiles; smoke test constructs an instance with stub Connection + stub fetch. |
| `mn-02-04-PLAN.md` | Parity tests + contract test | Create `packages/shared/test/solana-adapter-parity.test.ts` (4 methods × byte-identical diff). Create `packages/shared/test/chain-adapter-contract.test.ts` (interface-shape). Add `vitest.config.ts` to shared if missing. | Both test files green. |

Each PLAN is ≈5–8 atomic steps.

---

## 7. Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | A service-side call site WP-MN-03b needs is missing from the adapter interface | The mapping table in §2 enumerates every grepped call site; PLAN `mn-02-04` parity tests force each method to be exercised with real-shape inputs. If a missing method is discovered in WP-MN-03b, it can be additively ADDED to the interface (no reshape). |
| R2 | The `signer: unknown` type sacrifices type safety at the interface boundary | Acceptable per §4.2 rationale: signer shape is irreducibly VM-specific. The adapter impl narrows the type internally; the service caller types are unchanged (still hold `Keypair`). |
| R3 | The hand-coded Solana entry in chains.ts could drift from the production constants in protocol-v1-client | The entry sources `USDC_MINT_DEVNET`/`MAINNET` from `@pact-network/protocol-v1-client` constants — single source of truth. Drift impossible by construction. |
| R4 | shared's transitive @solana/web3.js dep will increase bundle size for any web consumer of shared | No web consumer of shared exists today. When Ken's SDK (WP-MN-05) consumes shared, it'll already need @solana/web3.js for Solana calls. EVM-only consumers (TBD) can tree-shake — `@solana/web3.js` is ESM and tree-shakable. |
| R5 | The Foundry `chains.json` import attribute in chains.ts may fail under some TS configs (same risk as WP-MN-01 T2 had with constants.ts) | Same mitigation: fallback to `readFileSync` per the T2 precedent. |
| R6 | Existing service tests may break if shared's new deps create version conflicts | Mitigation: PLAN `mn-02-03` Step 1 = run `pnpm install` after adding deps, then run `pnpm -r typecheck` and `pnpm -r test` to confirm green BEFORE proceeding to adapter impl. |

---

## 8. Open questions (none blocking)

- **Should `SolanaAdapter` expose `getCallRecord(callRecordPda)` for the settler retry/lookup helpers (currently inside submitter.service.ts at L362, L473–475)?** Defer to WP-MN-03b RESEARCH. The current settler logic can keep using `connection.getAccountInfo` directly (the connection is held inside SolanaAdapter; the adapter could expose it OR offer a `getCallRecord` method). Decision: WP-MN-03b RESEARCH chooses based on what the EvmAdapter equivalent looks like. WP-MN-02 doesn't preempt this.

---

## 9. Gate A request

This RESEARCH + the companion CONTEXT satisfy the Gate A entry criteria in `docs/superpowers/specs/2026-05-20-multi-network-phased-plan-design.md` §4.

**Captain (Tu / captain-proxy) — please review and emit `mn-02-CAPTAIN-GATE-A-VERDICT.md` with APPROVED or REJECTED + rationale.** On APPROVED, next step is to author 4 PLAN files via `superpowers:writing-plans` and execute via `superpowers:subagent-driven-development`.
