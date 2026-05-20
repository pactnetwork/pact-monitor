# WP-MN-04 — RESEARCH

- **Date:** 2026-05-20
- **Author:** captain-proxy on behalf of Tu
- **Status:** DRAFT — Gate A entry artifact, paired with `mn-04-CONTEXT.md` and the D6 reorg policy doc at `docs/evm/2026-05-20-reorg-policy.md`.

## 1 · Carry-forwards from WP-MN-03b — explicit resolution

From `mn-03b-REPORT-gateB.md` §"Carry forward to WP-MN-04 RESEARCH":

| Carry-forward | Resolution |
|---|---|
| EvmAdapter real impl replaces EvmAdapterStub | §3 of this doc enumerates every method's viem implementation against `@pact-network/protocol-evm-v1-client`. |
| D6 reorg/finality policy doc | Authored as `docs/evm/2026-05-20-reorg-policy.md` (Gate A entry, completed before this doc). |
| Arc fleet stand-up on testnet | §5 (settler EOA + Secret Manager) + §6 (chains.json fill) + §8 (Cloud Run + role grant runbook). |
| `PACT_ENABLED_NETWORKS=solana-devnet,arc-testnet` end-to-end smoke | §9 (e2e runbook). |
| `EndpointConfigSnapshot` projection drift (WP-MN-02 carry-forward) | §3.1 — EvmAdapter populates `authority` and `maxTotalFeeBps` from real on-chain view calls; consumers no longer need to dip into `raw` for EVM. Solana behavior unchanged. |
| `loadEndpoint` cache duplication (WP-MN-03b accepted-debt) | Out of scope for WP-MN-04; same posture as WP-MN-03b. Cleanup WP after 1 week stable. |

## 2 · State of the world — what's already shipped

Verified by reading on the umbrella branch tip `d093945`:

- `packages/protocol-evm-v1-client/src/` — viem-based, ABI-shipped. Modules `constants/addresses/encode/errors/helpers/state`. Arc Testnet deployed addresses BAKED into `addresses.ts:DEPLOYMENTS[5042002]` (registry, pool, settler). Env-overlay still available via `resolveDeployment` + `ENV_KEYS`.
- `packages/shared/src/adapters/evm/index.ts` — `EvmAdapterStub` (WP-MN-03b T2): rejects on `descriptor.vm !== 'evm'`; all four methods throw `"EvmAdapter not implemented — WP-MN-04"`.
- `packages/shared/src/chains.ts` — registry loads EVM chains from `program-evm/protocol-evm-v1/config/chains.json` at boot. Today only `arc-testnet` entry, with `rpcUrl/blockTimeMs/finalityBlocks = null`.
- `packages/shared/src/chain-adapter.ts` — `SettleBatchInput.latencyMs: number` (WP-MN-03b T1). `EligibilityCheckResult` shape locked.
- `packages/settler/src/config/secret-loader.service.ts` — Solana-only: hardcoded `SETTLEMENT_AUTHORITY_KEY` env, returns `Keypair`. Needs extension for per-VM signer-loading.
- `packages/settler/src/adapters/adapters.service.ts` — `AdaptersService` from WP-MN-03b T3 instantiates one adapter per network in `PACT_ENABLED_NETWORKS`. Currently constructs `EvmAdapterStub` for any `vm: 'evm'` entry.
- `packages/indexer/src/events/events.service.ts` — `ingest()` uses `findUnique({ network, signature, callId })`. Needs change to `findFirst({ network, callId })` per D6 §4.
- `packages/indexer/src/sync/on-chain-sync.service.ts` — `refreshAllNetworks()` from WP-MN-03b T4 iterates enabled networks and calls `adapter.readEndpointConfigs()`. Today, EVM throws via stub; once EvmAdapter is real, this cron path lights up the arc-testnet refresh.

The pattern is: every plumbing seam from WP-MN-03b is in place; WP-MN-04 fills the stub with a real impl and lights up the secrets/fleet config.

## 3 · `EvmAdapter` — method-by-method spec

File: `packages/shared/src/adapters/evm/index.ts` (replaces `EvmAdapterStub`).

```ts
import { createPublicClient, createWalletClient, http, type Address, type Hex,
  type PublicClient, type WalletClient, decodeEventLog, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET_CHAIN_ID, getDeployment, resolveDeployment,
  encodeSettleBatch, decodePactEventLog, decodeEndpointConfig, slugToBytes16,
  PactRegistryAbi, PactPoolAbi, PactSettlerAbi, PactEventsAbi
} from "@pact-network/protocol-evm-v1-client";

export interface EvmAdapterOptions {
  descriptor: ChainDescriptor;
  rpcUrl: string;
  signer?: { privateKey: Hex } | { walletClient: WalletClient };
  finalityBlocks: number;
  blockTimeMs: number;
  /** Default block from which to scan EndpointRegistered logs (deploy block). */
  deploymentBlock?: bigint;
}

export class EvmAdapter implements ChainAdapter {
  readonly descriptor: ChainDescriptor;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient | null;
  private readonly addrs: ReturnType<typeof resolveDeployment>;
  private readonly finalityBlocks: number;
  private readonly blockTimeMs: number;
  private readonly deploymentBlock: bigint;
}
```

### 3.1 `readEndpointConfigs()`

Goal: same shape as `SolanaAdapter` — `ReadonlyArray<EndpointConfigSnapshot>` covering every registered endpoint on chain.

Algorithm:

```
1. logs = publicClient.getLogs({
     address: addrs.registry,
     event: EndpointRegistered,
     fromBlock: deploymentBlock,
     toBlock: 'finalized',  // per D6 §1 (Arc supports finality tags)
   })
2. slugs = unique(logs[i].args.slug)  // bytes16
3. configs = await publicClient.multicall({
     contracts: slugs.map(s => ({ address: addrs.registry, abi: PactRegistryAbi,
                                  functionName: 'endpoints', args: [s] })),
     allowFailure: false,
   })
4. paused = await publicClient.multicall({
     contracts: slugs.map(s => ({ address: addrs.registry, abi: PactRegistryAbi,
                                  functionName: 'isPaused', args: [s] })),
   })
5. return configs.map((c, i) => projectToSnapshot(slugs[i], c, paused[i]))
```

`projectToSnapshot` produces the WP-MN-02 `EndpointConfigSnapshot` shape: `{ slug, authority, maxTotalFeeBps, feeRecipients, paused, raw }`. `authority` and `maxTotalFeeBps` come from the on-chain `EndpointConfig` view return — both are present on EVM (resolves the WP-MN-02 carry-forward for the EVM side).

**Cost:** N+1 RPC roundtrips for N endpoints (1 getLogs + 1 multicall view). At <100 endpoints, this is ~2s end-to-end on Arc Testnet. Cron interval (5 min) absorbs.

**Hidden gotcha:** `getLogs` with `fromBlock: deploymentBlock` to `toBlock: 'finalized'` can be paginated by some RPC providers. Use viem's built-in `getContractEvents` which paginates transparently, OR fall back to chunked-range loop with `blockRange: 5000`. Default to `getContractEvents` (cleaner).

### 3.2 `submitSettleBatch(input)`

The load-bearing method. Implements D6 §5.1 wait-loop verbatim.

```
1. calldata = encodeSettleBatch(input.events.map(e => ({
     callId: e.callId,                      // bytes16 hex
     agent: e.agent,                        // address
     premiumBaseUnits: e.premiumBaseUnits,  // bigint
     outcome: e.outcome === "ok" ? 0 : 1,
     feeRecipientCountHint: e.feeRecipientCountHint,
     latencyMs: e.latencyMs,
   })))
2. fees = await publicClient.estimateFeesPerGas({ chain }).catch(() => null)
   if (fees) {
     maxFeePerGas = fees.maxFeePerGas * 120n / 100n           // +20%
     maxPriorityFeePerGas = fees.maxPriorityFeePerGas
   } else {
     // legacy fallback (D6 §3 step 2)
     gp = await publicClient.getGasPrice()
     gasPrice = gp * 120n / 100n
   }
3. gasLimit = await publicClient.estimateGas({
     account: signer.address, to: addrs.settler, data: calldata,
   }) * 130n / 100n     // +30%
4. txHash = await walletClient.sendTransaction({
     to: addrs.settler, data: calldata, gas: gasLimit,
     ...(fees ? { maxFeePerGas, maxPriorityFeePerGas } : { gasPrice }),
   })
5. // wait-loop per D6 §5.1
   const start = Date.now()
   const timeoutMs = finalityBlocks * blockTimeMs * 3
   while (true) {
     const receipt = await publicClient.getTransactionReceipt({ hash: txHash })
                       .catch(() => null)
     if (receipt) {
       if (receipt.status === 'reverted') {
         throw new Error(`settle reverted: ${decodeRevertReason(receipt)}`)
       }
       const current = await publicClient.getBlockNumber()
       const depth = current - receipt.blockNumber + 1n
       if (depth >= BigInt(finalityBlocks)) {
         return { txId: txHash, perEvent: input.events.map(e => ({
           callId: e.callId, status: 'settled',
         })) }
       }
     }
     if (Date.now() - start > timeoutMs) throw new Error(`settle timeout`)
     await sleep(blockTimeMs)
   }
6. // on revert: surface via existing protocol-evm-v1-client/src/errors.ts decoder
   if (err is ContractFunctionRevertedError) {
     const decoded = decodeRevertReason(err)
     // map to perEvent: status='rejected', reason=decoded.shortName
   }
```

Notes:
- `perEvent` shape currently only emits `'settled'` on success. Per-event `'replayed'` or `'rejected'` granularity requires reading the `CallSettled` event logs from the receipt and matching them to input events. WP-MN-04 T2 ships the receipt-log-matching to populate per-event status accurately. This is materially better than the Solana side (which today emits uniform `'settled'`).
- `decodeRevertReason` is already shipped in `protocol-evm-v1-client/src/errors.ts`.
- Per D6 §3 step 4: estimateGas failures (e.g., on-chain `DuplicateCallId` prevented broadcast) → throw before sendTransaction → settler queue receives retry-after-error.

### 3.3 `checkAgentEligibility(agent, requiredBaseUnits)`

Two view calls against the USDC ERC-20:

```
balance   = readContract({ abi: ERC20Abi, address: usdc, functionName:'balanceOf',
                            args: [agent] })
allowance = readContract({ abi: ERC20Abi, address: usdc, functionName:'allowance',
                            args: [agent, addrs.settler] })
if (balance < requiredBaseUnits)
  return { eligible: false, reason: 'insufficient_balance', balance, allowance }
if (allowance < requiredBaseUnits)
  return { eligible: false, reason: 'insufficient_allowance', balance, allowance }
return { eligible: true, balance, allowance }
```

Map the WP-MN-02 `EligibilityRejectionReason` literals (`'insufficient_balance' | 'insufficient_allowance' | 'no_account'`). On EVM there's no "no account" concept (every address is implicit); EVM never returns `'no_account'`.

`ERC20Abi` — minimal: `[{name:'balanceOf', ...}, {name:'allowance', ...}]`. Define inline or under `protocol-evm-v1-client/src/abi/ERC20.ts`. Inline is simpler.

**Multicall optimization:** combine the two reads into a single `publicClient.multicall` to halve round-trips. Adopted.

### 3.4 `tailSettlementEvents?(opts)` — OPTIONAL, post-v1

Per D6 §5.2, the reconcile-tail consumer powers the manual hard-reorg detection. Adapter exposes it:

```
async *tailSettlementEvents(opts: TailOptions) {
  const fromBlock = BigInt(opts.fromBlockOrSlot)
  while (true) {
    const finalized = await publicClient.getBlock({ blockTag: 'finalized' })
    const logs = await publicClient.getContractEvents({
      address: addrs.settler, abi: PactEventsAbi, eventName: 'CallSettled',
      fromBlock, toBlock: finalized.number,
    })
    for (const log of logs) {
      const decoded = decodePactEventLog(log)  // from state.ts
      yield {
        callId: decoded.callId,
        settlementSig: log.transactionHash,
        slug: decoded.slug,
        agent: decoded.agent,
        amount: decoded.amount,
        blockNumber: log.blockNumber,
      }
    }
    fromBlock = finalized.number + 1n
    await sleep(opts.pollIntervalMs ?? 60_000)
  }
}
```

WP-MN-04 ships the impl. The cron daemon that consumes it is shipped as the operator CLI (per D6 §5.2 — manual not automatic).

## 4 · Indexer dedup change

File: `packages/indexer/src/events/events.service.ts`.

Current (post-WP-MN-03a, composite-key upserts):

```ts
const existing = await this.prisma.settlement.findUnique({
  where: { network_signature_callId: { network, signature, callId } },
})
```

New (per D6 §4):

```ts
const existing = await this.prisma.settlement.findFirst({
  where: { network, callId },
})
```

That's the only logic change. The schema PK `@@id([network, signature, callId])` stays — it's the storage key, not the dedup key. Insert path remains `prisma.settlement.create({ data: { network, signature, callId, ... } })`; if a hard-reorg replay sneaks through under a new `signature`, the new `findFirst` catches it before the insert.

Tests:
- New unit test: ingest event with `(network='solana-devnet', signature='SIGa', callId='CID1')` → 201. Ingest same `callId` with different `signature='SIGb'` → 200 idempotent (was 201 before). DB still has one row.
- Existing tests adjusted: any test asserting "two rows with same callId different signature" is wrong post-D6 and updates.

## 5 · Settler EOA secret loading — per-VM

File: `packages/settler/src/config/secret-loader.service.ts`.

Current: hardcoded to `SETTLEMENT_AUTHORITY_KEY` env, decodes base58, returns Solana `Keypair`.

New: per-network loader keyed by `pact-settler-<network>`. Returns a discriminated union:

```ts
type LoadedSigner =
  | { vm: 'solana'; keypair: Keypair }
  | { vm: 'evm'; account: PrivateKeyAccount; address: Address };

class SecretLoaderService {
  async loadFor(network: string): Promise<LoadedSigner> {
    const desc = getChain(network);
    const envKey = `PACT_SETTLER_KEYPAIR_${network.toUpperCase().replace(/-/g, '_')}`;
    // Back-compat: legacy `SETTLEMENT_AUTHORITY_KEY` is treated as solana-devnet only
    const raw = this.config.get<string>(envKey)
             ?? (desc.network === 'solana-devnet'
                 ? this.config.get<string>('SETTLEMENT_AUTHORITY_KEY') : null)
             ?? null;
    if (!raw) throw new Error(`no signer secret for network ${network}`);
    const value = raw.startsWith('projects/') ? await this.fetchSecretManager(raw) : raw;
    return desc.vm === 'solana'
      ? { vm: 'solana', keypair: Keypair.fromSecretKey(bs58.decode(value)) }
      : (() => {
          const acct = privateKeyToAccount(value.startsWith('0x') ? value as Hex
                                                                  : `0x${value}` as Hex);
          return { vm: 'evm', account: acct, address: acct.address };
        })();
  }
}
```

Env keys, locked:

| Network | Env var | Phase 1 value (Tu, now) | Phase 2 value (Rick, later) |
|---|---|---|---|
| `solana-devnet` | `SETTLEMENT_AUTHORITY_KEY` (legacy, kept for back-compat) OR `PACT_SETTLER_KEYPAIR_SOLANA_DEVNET` | base58 keypair string OR `projects/...` (already deployed) | unchanged |
| `arc-testnet` | `PACT_SETTLER_KEYPAIR_ARC_TESTNET` | raw `0x`-hex private key | `projects/<gcp>/secrets/pact-settler-arc-testnet/versions/latest` |

**Two-phase rationale (D6 §6 lock):** Tu does not currently have GCP IAM permission to create Secret Manager secrets. Rick owns that capability. The settler's `loadFor()` already detects the `projects/...` prefix and routes through Secret Manager, so the code is identical for both phases — only the env *value* changes. Phase 1 stores the hex key directly in Cloud Run env (encrypted at rest by Google; only Tu + Rick have IAM access to the revision spec). Phase 2 is a Rick-owned follow-up: create the secret, add a version with the same hex, swap the Cloud Run env value to the resource path, roll the revision. No code redeploy, no behavior change.

Rotation procedure: per D6 §6. The Solana model already supports this loader shape (`SETTLEMENT_AUTHORITY_KEY` is honored).

Adapter consumes: `AdaptersService.bootstrap` calls `loadFor(network)`; for `vm: 'evm'` it constructs `EvmAdapter({ ..., signer: { walletClient: createWalletClient({ account, transport: http(rpcUrl) }) } })`.

## 6 · `chains.json` fill — VALUES LOCKED

File: `packages/program-evm/protocol-evm-v1/config/chains.json`.

```json
{
  "arc-testnet": {
    "chainId": 5042002,
    "name": "arc-testnet",
    "usdcAddress": "0x3600000000000000000000000000000000000000",
    "usdcDecimals": 6,
    "rpcUrl": "<value of ARC_TESTNET_RPC_URL from packages/program-evm/protocol-evm-v1/.env — public; committed verbatim>",
    "blockTimeMs": 500,
    "finalityBlocks": 64,
    "deploymentBlock": 42953139
  }
}
```

- `rpcUrl`: **Tu-confirmed default — copy the value of `ARC_TESTNET_RPC_URL` from `packages/program-evm/protocol-evm-v1/.env` (public URL, safe to commit).** T1 implementer pulls + commits.
- `blockTimeMs: 500` — D6 §2.
- `finalityBlocks: 64` — D6 §2.
- `deploymentBlock: 42953139` — **PactRegistry deploy block on Arc Testnet chain 5042002**, extracted from `packages/program-evm/protocol-evm-v1/broadcast/Deploy.s.sol/5042002/run-latest.json` (deploy tx `0x8fc3ae...42fb`, hex `0x28f69b3` = decimal 42953139). Used by `EvmAdapter.readEndpointConfigs()` as `fromBlock` for `EndpointRegistered` log scan. PactPool (42953143) and PactSettler (42953150) are 4 and 11 blocks later; Registry's block is the earliest and is the correct cursor (endpoints can't exist before the registry).

`@pact-network/shared/chains.ts` propagation: today only reads `chainId`, `name`, `usdcAddress`, `usdcDecimals`. Extends to also surface `rpcUrl`, `blockTimeMs`, `finalityBlocks`, `deploymentBlock` on `ChainDescriptor`. Three new optional fields on the interface; Solana entries leave them `undefined`.

## 7 · Indexer reorg-rollback module

File: `packages/indexer/src/reorg/` (new module). Exports:
- `ReorgService` — Nest provider with `runReconcile(network: string)`: iterates `tailSettlementEvents()` from the adapter; for each canonical-chain event, looks up DB; for each DB `Settlement` from the last 24h NOT seen on chain → flagged in `settlement_reorg_audit` view.
- `ReorgRollbackCli` — invoked by `pnpm --filter @pact-network/indexer reorg:rollback --network <n> --call-id <id>`. Per D6 §5.2 step 3.

Schema (local-docker-only per Tu's directive):

```prisma
view settlement_reorg_audit {
  network    String
  callId     String
  signature  String
  amount     BigInt
  detectedAt DateTime
  @@map("settlement_reorg_audit")
}
```

This is a Prisma `view` (read-only). No production-DB write. Local docker `pnpm prisma migrate dev`.

**Not in scope:** the cron daemon that auto-runs `runReconcile`. WP-MN-04 ships the service + CLI; auto-cron lights up in a follow-up after operator-driven shakedown.

## 8 · Cloud Run + Secret Manager provisioning — runbook

T6 task. Tu-executable checklist (NOT captain-proxy auto-driven):

**Pre-flight (Tu-executable; no new EOA generation needed — REUSE THE DEPLOYER EOA):**

Tu's Q3+Q4 lock: the deployer EOA from `packages/program-evm/protocol-evm-v1/.env`
(`DEPLOYER_PRIVATE_KEY`, address `0x777d569bd3b0a2de007097a3d7e1687c5e5eb859`)
**doubles as the Arc Testnet settler EOA**. Arc Testnet only; mainnet will rotate to a
separate settler EOA per D6 §6 (out of WP-MN-04 scope).

Because `Deploy.s.sol` granted `SETTLER_ROLE` on `PactSettler` only to the
PactSettler contract address (so it can call `PactRegistry`/`PactPool` restricted
fns), no EOA holds `SETTLER_ROLE` on `PactSettler` itself today. One self-grant tx
is needed from the deployer (who holds `DEFAULT_ADMIN_ROLE` on PactSettler via
`registry.authority()`):

1. **One-time self-grant** — Tu runs from a shell with `DEPLOYER_PRIVATE_KEY` in scope:
   ```bash
   cd packages/program-evm/protocol-evm-v1
   source .env
   cast send 0xe461CE50ef53BFC10945B101FB94b11Ec5eB591f \
     "grantRole(bytes32,address)" \
     $(cast keccak "SETTLER_ROLE") \
     0x777d569bd3b0a2de007097a3d7e1687c5e5eb859 \
     --rpc-url "$ARC_TESTNET_RPC_URL" \
     --private-key "$DEPLOYER_PRIVATE_KEY"
   ```
   Verify with `cast call 0xe461CE... "hasRole(bytes32,address)" $(cast keccak "SETTLER_ROLE") 0x777d56...` → `0x...01`.
2. Confirm Arc EOA gas-token balance: `cast balance 0x777d569bd3b0a2de007097a3d7e1687c5e5eb859 --rpc-url "$ARC_TESTNET_RPC_URL"` is non-zero. If not, fund via Arc Testnet faucet (`ARC_TESTNET_FAUCET_URL` in `.env`).

**Cloud Run env update (3 services — Phase 1, raw-hex env, `PACT_LEGACY_DIRECT_SOLANA=false`):**

3. Settler revision: append env
   - `PACT_ENABLED_NETWORKS=solana-devnet,arc-testnet`
   - `PACT_SETTLER_KEYPAIR_ARC_TESTNET=<value of DEPLOYER_PRIVATE_KEY from .env>` — raw 0x-hex, NOT a Secret Manager path (Phase 2 is Rick's follow-up per D6 §6)
   - `PACT_LEGACY_DIRECT_SOLANA=false` (Tu Q6 — adapter path on both networks day 1; WP-MN-03b proved byte-identical)
4. Indexer revision: append env
   - `PACT_ENABLED_NETWORKS=solana-devnet,arc-testnet`
   - `PACT_LEGACY_DIRECT_SOLANA=false`
5. Market-proxy revision: append env
   - `PACT_ENABLED_NETWORKS=solana-devnet,arc-testnet`
   - `PACT_LEGACY_DIRECT_SOLANA=false`
6. **Cloud Run min-instances**: leave at `min=1` for the Arc-enabled revisions (Tu Q5 default — keeps EVM signer warm, matches Solana posture).
7. Roll all three revisions; verify boot logs print "[adapter map] solana-devnet=SolanaAdapter arc-testnet=EvmAdapter" or equivalent.

**Verification:**
8. `curl <settler-url>/health` → 200.
9. `curl <indexer-url>/api/endpoints?network=arc-testnet` → 200 (empty array until first registerEndpoint).
10. `curl <market-proxy-url>/health` → 200.

**Rick follow-up (Phase 2 — Secret Manager upgrade, NOT blocking WP-MN-04):**
- R1. `gcloud secrets create pact-settler-arc-testnet --replication-policy=automatic`
- R2. `echo -n "0x<privatekey>" | gcloud secrets versions add pact-settler-arc-testnet --data-file=-`
- R3. Settler Cloud Run revision: change `PACT_SETTLER_KEYPAIR_ARC_TESTNET` value from raw hex to `projects/<gcp>/secrets/pact-settler-arc-testnet/versions/latest`. Code path is identical (loader detects `projects/...` prefix); only the env value swaps.
- R4. Roll settler revision; verify boot logs.
- R5. (Hygiene) Once Phase 2 is verified for 1 week, Rick can scrub the raw hex from prior Cloud Run revision history if desired — past revisions retain the old env value until Cloud Run prunes them.

This runbook is for Tu, not for code. Captain-proxy ships everything up to step 4's pre-flight; Tu executes 1-10. Rick executes R1-R5 as a separate ops cycle.

## 9 · End-to-end smoke runbook (Arc Testnet)

After §8 fleet is up:

1. Register an Arc endpoint:
   - `pnpm cli endpoint register --network arc-testnet --slug arctest1 --upstream "https://httpbin.org/get" --flat-premium 100000` (100k base units = 0.1 USDC at 6 decimals)
   - Tu signs from the registry-authority EOA.
2. Top up the pool: 1 USDC → `PactPool.topUp(slug, 1_000_000)`.
3. Agent EOA approves `PactSettler` for 1 USDC.
4. Agent makes a wrapped HTTP call to `<market-proxy-url>/v1/arctest1/get`.
5. Proxy debits 0.1 USDC, settles batch on Arc, indexer ingests with `network='arc-testnet'`.
6. Read API: `GET /api/calls/<callId>?network=arc-testnet` → 200 with the row.
7. Dashboard: filter `network=arc-testnet` shows the call.

Pass criteria: all 7 steps succeed without manual intervention. This is a runbook, not an automated test — testnet RPC + real spend make CI-automation undesirable for WP-MN-04.

## 10 · Risks (per phased plan §7)

| Risk | Mitigation | Status |
|---|---|---|
| R1: Per-VM auth + reorg policy unwritten when fleet boots | D6 hard Gate A entry gate — written FIRST as `docs/evm/2026-05-20-reorg-policy.md` | RESOLVED — D6 doc complete |
| R2: Arc finality poorly understood; wrong `finalityBlocks` causes flapping | Conservative default 64 blocks; observation-based tuning post-mainnet decision | MITIGATED |
| R3: Cloud Run cold-start interacts with settler's batch loop | Replicate existing Solana settler precedent (warm pool + min-instances) | INHERITED — same posture as Solana fleet |
| R4 (new): EVM event-log pagination on `getLogs` from deploymentBlock | Use viem `getContractEvents` which paginates transparently | MITIGATED |
| R5 (new): RPC node refuses EIP-1559 fees | Legacy `gasPrice` fallback per D6 §3 step 2 | MITIGATED |
| R6 (new): Settler EOA gets de-allowlisted (e.g., re-deploy of PactSettler) | Pre-T1 prerequisite: Tu signs `grantRole(SETTLER_ROLE, addr)` before fleet boots; verified at smoke step 5 | OPERATIONAL CHECK |

## 11 · Sub-task breakdown (T1..T6)

| # | Title | Files | Atomic? | Depends-on |
|---|---|---|---|---|
| T1 | `chains.json` fill + `ChainDescriptor` extension | `packages/program-evm/protocol-evm-v1/config/chains.json`, `packages/shared/src/chain-adapter.ts`, `packages/shared/src/chains.ts`, `packages/shared/test/chains-evm.test.ts` | Y | none |
| T2 | `EvmAdapter` real impl + contract-conformance test | `packages/shared/src/adapters/evm/index.ts` (full rewrite), `packages/shared/test/evm-adapter-contract.test.ts`, `packages/shared/test/evm-adapter-unit.test.ts` | Y | T1 |
| T3 | Indexer dedup change + reorg-rollback module | `packages/indexer/src/events/events.service.ts` (lookup change + tests), `packages/indexer/src/reorg/{reorg.module,reorg.service,reorg-rollback.cli}.ts`, `packages/db/prisma/schema.prisma` (audit view), local docker migration | Y | T1 |
| T4 | Settler `secret-loader` per-VM + AdaptersService EVM construction | `packages/settler/src/config/secret-loader.service.ts` (rewrite to `loadFor(network)`), `packages/settler/src/adapters/adapters.service.ts` (construct real EvmAdapter), `packages/indexer/src/adapters/adapters.service.ts` (same), `packages/market-proxy/src/lib/context.ts` (same) | Y | T1, T2 |
| T5 | E2E unit test: arc-testnet routing with mocked viem | `packages/settler/test/arc-testnet-routing.spec.ts`, `packages/market-proxy/test/arc-testnet-routing.spec.ts` | Y | T2, T4 |
| T6 | Provisioning runbook + Gate B exit | `.planning/phases/mn-04-evm-fleet/runbook-fleet-boot.md`, `mn-04-REPORT-gateB.md` | N — Tu executes the runbook | T1..T5 |

T6 is the only non-atomic task and the only Tu-executable one. T1..T5 are captain-proxy auto-driven IF Tu authorizes; T6 is always Tu.

## 12 · Gate-B exit (7-cat) — preview

Per phased plan §7:
1. T1..T5 PLANs closed (T6 is runbook-only).
2. Tests green: full suite + new EvmAdapter contract + unit + reorg-replay dedup unit + arc-testnet routing.
3. Drift: `chain-adapter-contract.test.ts` passes for EvmAdapter (re-use WP-MN-02 conformance suite). Reorg fixture test passes.
4. Spec-parity: matches D6 verbatim (every algorithm cited); off-chain §2.5/§2.6/§7; phased plan §7.
5. Rollback: tag `pre-mn-05-rollback`. Arc fleet is additive — disabling = remove `arc-testnet` from `PACT_ENABLED_NETWORKS` and roll Cloud Run.
6. Captain Gate B APPROVED.
7. Handoff updated; cleanup-WP follow-up tracked.

## 13 · Open questions — ALL LOCKED 2026-05-20

| # | Question | Tu answer | Lock site |
|---|---|---|---|
| 1 | Arc Testnet RPC URL | Default — use `ARC_TESTNET_RPC_URL` from `.env` (public, commit verbatim) | §6 chains.json |
| 2 | PactRegistry deploy block | **42953139** (from `broadcast/Deploy.s.sol/5042002/run-latest.json`) | §6 chains.json |
| 3 | Arc EOA custody | **Reuse `DEPLOYER_PRIVATE_KEY` from `.env`** as the settler EOA. Address `0x777d569bd3b0a2de007097a3d7e1687c5e5eb859`. Arc Testnet only; mainnet rotates per D6 §6. | §5 secret loader, §8 runbook |
| 4 | `grantRole` signing | Same key as #3 (deployer holds `DEFAULT_ADMIN_ROLE` on PactSettler via `registry.authority()`). One self-grant tx in T6 step 1. | §8 runbook step 1 |
| 5 | Cloud Run min-instances | Default — `min=1`, match Solana posture | §8 runbook step 6 |
| 6 | `PACT_LEGACY_DIRECT_SOLANA` | **`=false` on all 3 services from day 1** (Option A) — adapter path on both networks. WP-MN-03b proved byte-identical perEventShares. Flag deletion is the cleanup WP after 1 week stable. | §8 runbook steps 3-5 |

No remaining blockers. T1 may start on captain-proxy authorization.

## 14 · References

- D6: `docs/evm/2026-05-20-reorg-policy.md`
- Off-chain spec: `docs/evm/2026-05-19-multi-network-offchain-services-spec.md` (on `docs/multi-network-design`)
- Architecture spec: `docs/evm/2026-05-19-multi-network-architecture-spec.md`
- Phased plan §7: `docs/superpowers/specs/2026-05-20-multi-network-phased-plan-design.md`
- WP-MN-03b Gate B: `.planning/phases/mn-03b-services-swap/mn-03b-REPORT-gateB.md`
- Arc deployed addresses: `packages/protocol-evm-v1-client/src/addresses.ts:DEPLOYMENTS[5042002]`
- WP-EVM-07 deploy artifacts: `docs/superpowers/specs/2026-05-15-arc-parity-port-design.md` and parity matrix.
