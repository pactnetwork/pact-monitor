# Spike 4 — ERC-7857 INFT reference research

**Proves:** There is a usable reference implementation for ERC-7857 we can fork (with caveats), so the plan's `EndpointINFT.sol` is feasible without writing the standard from scratch.

**Status:** Researched. Reference contract identified. Forkable, but heavier than the plan assumed — see "Path forward" below.

## Reference implementation

**Repo:** [`0gfoundation/0g-agent-nft`](https://github.com/0gfoundation/0g-agent-nft)

**License:** CC0-1.0 (public domain — copy/fork freely)
**Language:** Solidity, upgradeable

**Branch to fork:** `main` (last push 2026-02-02). Earlier notes pointed at
`eip-7857-draft`, but that branch is **stale by 9 months** (last commit
2025-05-27). The `main` branch is the active one and includes the newer
`ERC7857Upgradeable.sol` + `TeeVerifier.sol`.

**File layout (`main` branch):**

```
contracts/
  AgentNFT.sol             — main ERC-7857 implementation
  AgentMarket.sol          — secondary market (we don't need this)
  ERC7857Upgradeable.sol   — base upgradeable contract
  TeeVerifier.sol          — TEE-proof verifier (we replace with AlwaysOkVerifier)
  Utils.sol
  extensions/
  interfaces/              — IERC7857, IERC7857Metadata, IERC7857DataVerifier
  proxy/
  verifiers/
```

## Surface that matters for Pact-0G

```solidity
function mint(
    bytes[]   calldata proofs,
    string[]  calldata dataDescriptions,
    address   to
) public payable virtual returns (uint256 tokenId);

function tokenURI(uint256 tokenId)
    public view virtual returns (string memory);   // returns JSON: { chainURL, indexerURL }
```

**Per-token state:**
- `address owner`
- `string[] dataDescriptions`
- `bytes32[] dataHashes`
- `address[] authorizedUsers`
- `address approvedUser`

**Initialization signature** (from the inherited initializer):
`initialize(name, symbol, verifierAddress, chainURL, indexerURL)`

## Critical dependency: `IERC7857DataVerifier`

The mint path calls `verifier.verifyPreimage(proofs)`. **We must deploy a verifier contract first**, or mint reverts. Two options:

1. **Use 0G's reference verifier** under `contracts/verifiers/` in the same repo. Adds another contract to deploy and verify on `chainscan.0g.ai`. Faithful to the standard.
2. **Write a stub `AlwaysOkVerifier`** that returns `true` regardless of proofs. Honest but lazy — we have no TEE / ZKP gates in the hackathon scope anyway. Documented as a known v1.1 gap.

Plan recommends option **2** for hackathon. Pact-0G doesn't need real metadata gating — INFTs here are slug labels with on-chain identity, not gated AI models.

## Path forward (Week 1 contract day)

```
packages/protocol-zerog-contracts/
  src/
    inft/
      EndpointINFT.sol         — forked from AgentNFT.sol, hackathon-trimmed
      IERC7857.sol             — copied verbatim
      IERC7857Metadata.sol     — copied verbatim
      IERC7857DataVerifier.sol — copied verbatim
      AlwaysOkVerifier.sol     — 10-line stub: returns true on any proofs
  test/
    EndpointINFT.t.sol         — mint, tokenURI, transfer-blocked-without-key
```

### Hackathon trims to apply when forking

- Remove the `payable` modifier on `mint` (we charge in `MockUsdc`, not native).
- Remove the upgradeable proxy — `PactCore` itself isn't upgradeable, INFT shouldn't be either. Use OZ `AccessControl` non-upgradeable variant.
- Strip transfer / authorizeUsage / sealed-key logic that we explicitly don't use. Keep the `mint` + `tokenURI` + ownership read paths only.
- Bind `tokenURI` to return the 0G Storage URL for the metadata blob: `https://indexer-storage-turbo.0g.ai/file?root=<dataHashes[0]>`. The plan stores endpoint metadata `{ slug, upstream_model, registered_at, owner }` on 0G Storage and references the rootHash here.

### Foundry remapping

```
@openzeppelin/=lib/openzeppelin-contracts/contracts/
@0gfoundation/inft/=lib/0g-agent-nft/contracts/
```

Install via:

```bash
forge install OpenZeppelin/openzeppelin-contracts --no-commit
forge install 0gfoundation/0g-agent-nft --no-commit   # defaults to main branch (latest)
```

## Plan amendment

Update [the plan](~/.claude/plans/ok-great-lets-brainstorm-steady-stearns.md):
section "`EndpointINFT` — minimal ERC-7857 contract" — replace the "use
OpenZeppelin if compatible reference exists" line with the concrete path above.
Note that we ship an `AlwaysOkVerifier` stub instead of real proof checks.

## Risks resolved by this spike

- ✓ Reference contract exists and is CC0 — no licensing blocker
- ✓ Interface surface is concrete — no guessing
- ✓ Mint dependency chain understood — verifier stub is the smallest practical bypass
- ⚠️ Upgradeable proxy will be removed during the fork — verify gas / size delta in Foundry

## Risks NOT resolved by this spike

- ❌ Whether mainnet has any existing INFT deployments we can study (none documented)
- ❌ Whether the verifier stub will be accepted by judges as a "real Agent ID integration" — mitigate by writing demo copy that's honest about the scope ("ERC-7857 mint per endpoint; full proof gating deferred")
