# @q3labs/pact-operator-sdk

Operator-side SDK for **Pact Network V1**. Caller holds the protocol authority
key (or a `CoveragePool` authority key for `topUp`) and runs endpoint
onboarding / config / pause / fee-split ops with smart-submit semantics
(simulate-first, priority-fee, CU budget, blockheight-bounded retry).

## V1 constraints — read this first

- **There is no `withdraw_from_pool` instruction.** V1 distributes fees
  per-settlement via `settle_batch`'s fee fan-out. Affiliates earn passively
  into their ATA; there is nothing for an operator or affiliate to "withdraw".
- **All endpoint config / pause / fee-recipient ops require
  `ProtocolConfig.authority`** (singleton). Future Squads multisig rotation
  is supported via the build-only API (see below).
- **`top_up_coverage_pool` is the one op that uses `CoveragePool.authority`**
  (per-pool). This SDK pre-flights the distinct authority and throws
  `OperatorError.POOL_AUTHORITY_MISMATCH` with the expected/actual pubkeys
  in `details` if the wrong signer is passed.
- **`registerEndpoint` requires two signers** (authority + a fresh `poolVault`
  keypair) because the program initializes a new SPL Token account from a
  caller-allocated address.

## Authority cheat-sheet

| Op | Required signer (= on-chain authority field) |
| --- | --- |
| `registerEndpoint` | `ProtocolConfig.authority` + a fresh pool-vault keypair |
| `updateEndpointConfig` | `ProtocolConfig.authority` |
| `pauseEndpoint` | `ProtocolConfig.authority` |
| `updateFeeRecipients` | `ProtocolConfig.authority` |
| `topUpCoveragePool` | `CoveragePool.authority` |

## Install

```bash
pnpm add @q3labs/pact-operator-sdk @q3labs/pact-protocol-v1-client @solana/web3.js
```

## Quick start

```ts
import { Connection, Keypair } from "@solana/web3.js";
import { PROGRAM_ID, USDC_MINT_MAINNET } from "@q3labs/pact-protocol-v1-client";
import { createOperator } from "@q3labs/pact-operator-sdk";

const operator = createOperator({
  connection: new Connection("https://api.mainnet-beta.solana.com"),
  programId: PROGRAM_ID,        // pass PROGRAM_ID_DEVNET for the devnet deploy (reads-only)
  usdcMint: USDC_MINT_MAINNET,  // or USDC_MINT_DEVNET
});

const authority = Keypair.fromSecretKey(/* protocol authority secret */);
const poolVault = Keypair.generate(); // fresh keypair for the new pool's USDC vault

// One-call, single-signer, smart-submit:
const { signature } = await operator.registerEndpoint(
  authority,
  poolVault,
  {
    slug: "acme-api",
    flatPremiumLamports: 1000n,
    percentBps: 0,
    slaLatencyMs: 2000,
    imputedCostLamports: 10000n,
    exposureCapPerHourLamports: 1_000_000n,
    poolVault: poolVault.publicKey, // matches the keypair passed above
  },
);
```

The `submit*` helpers all run **simulate → priority-fee → CU budget → send →
confirm-with-blockheight**. They throw structured `OperatorError`s:
`SIMULATION_FAILED` (with on-chain logs in `details.logs`),
`AUTHORITY_MISMATCH`, `POOL_AUTHORITY_MISMATCH`,
`ENDPOINT_ALREADY_REGISTERED`, `BLOCK_HEIGHT_EXCEEDED`, `RPC_ERROR`.

## Build-only API (for multisig / batching)

For a Squads-held protocol authority (CLAUDE.md requires this rotation before
mainnet), use `operator.build.*` to get raw instructions, then wrap them
via `@sqds/multisig`. No `MultisigSigner` abstraction — that contract is too
leaky to wrap, and Drift / MarginFi / Chainlink CCIP all follow the same
pattern.

```ts
import * as multisig from "@sqds/multisig";

const { instructions } = operator.build.updateEndpointConfig(
  /* authority */ multisigVaultPda,
  { slug: "acme-api", flatPremiumLamports: 2000n },
);

// Wrap as a Squads vault transaction:
await multisig.rpc.vaultTransactionCreate({
  connection,
  multisigPda,
  transactionIndex,
  creator: proposer.publicKey,
  vaultIndex: 0,
  ephemeralSigners: 0,
  transactionMessage: new TransactionMessage({
    payerKey: multisigVaultPda,
    recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
    instructions,
  }),
  // …
});
// Then proposalCreate → proposalApprove × N → vaultTransactionExecute.
```

## Affiliate reads

Coming in the next release (PR-2): read-only earnings observability for any
`AffiliateAta` fee-recipient. Two new indexer routes
(`GET /api/recipients/:pubkey` lifetime; `GET /api/recipients/:pubkey/settlements`
cursor-paginated) and a `createAffiliate(pubkey)` factory.

## Smart-submit details

`smartSubmit` is exported standalone if you want the same semantics on an
arbitrary `TransactionInstruction[]`:

```ts
import { smartSubmit } from "@q3labs/pact-operator-sdk";

const { signature, computeUnitsConsumed } = await smartSubmit({
  connection,
  instructions,
  signer,
  priorityFeeAccounts: [poolPda, vaultAta], // writable lanes — bias the RPC
  options: {
    priorityFeePercentile: 75,
    priorityFeeFallback: 1000,
    computeUnitLimit: 200_000,
    simulateFirst: true,
    pollIntervalMs: 1500,
  },
});
```

Reference: [Helius `sendSmartTransaction` semantics](https://github.com/helius-labs/helius-sdk).
Don't skip simulate-first on admin writes — `AUTHORITY_MISMATCH` /
`PROTOCOL_PAUSED` failures show up in simulation logs and save a tx fee.

## Risks the SDK does not paper over

- **Devnet `5jBQb7fL…` cannot settle** due to a `declare_id!` mismatch in the
  V1 binary (the deploy address differs from the program's hardcoded ID).
  Reads work; `register` and `topUp` work; `settle_batch` reverts
  `InvalidSeeds`. Operator ops are unaffected; settlement-dependent flows
  (any test that observes a real refund) are not.
- **The indexer's `POST /api/ops/*` API is not consumed by this SDK.** Its
  ops service returns a base64-JSON blob (not a Solana tx) and has no nonce
  replay protection. Bug refs: `packages/indexer/src/ops/ops-disabled-in-prod.guard.ts`.
