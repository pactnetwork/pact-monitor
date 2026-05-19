# WP-EVM-07 — Captain GATE B Verdict: APPROVED (Arc EVM track COMPLETE)

Independently verified against the LIVE chain + repo — not a rubber-stamp.
Every claim re-checked by the captain directly:

## On-chain (captain ran cast against https://rpc.testnet.arc.network)

- All 3 contracts have bytecode (registry/pool/settler codelen 16255/8457/12019).
- registry.authority() = 0x777d569Bd3b0A2De007097A3D7E1687C5E5EB859 = deployer
  EOA. C1 SATISFIED (authority = deployer; the separate-authority branch was
  correctly removed).
- registry.treasuryVault() = 0x777d569Bd3b0A2De007097A3D7E1687C5E5EB859 (=
  deployer EOA) — EXACTLY the C2 item-2 ratified value (07-C2-RATIFICATION.md).
- pool.usdc() = 0x3600000000000000000000000000000000000000 = ArcConfig USDC.
- settler.registry() = 0x056BAC33546b5b51B8CF6f332379651f715B889C = deployed
  PactRegistry. Wiring correct.
- registry.hasRole(SETTLER_ROLE, settler) = true AND pool.hasRole(...) = true.
  The two-layer E1xE2 grant is live — only possible because deployer ==
  authority == DEFAULT_ADMIN_ROLE holder; proves C1 was implemented correctly
  end-to-end (not just in source).
- registry.maxTotalFeeBps() = 3000 = exact Solana parity
  (constants.rs:23 DEFAULT_MAX_TOTAL_FEE_BPS).

## Repo / integrity (captain verified)

- ZERO contract-source change across WP-07: `git diff 07a79be..HEAD --
  packages/program-evm/protocol-evm-v1/src/` is EMPTY. The hard "NO contract
  change" constraint is provably honored.
- check:abi PASS — captain re-ran independently: all 5 ABIs (PactRegistry 49 /
  PactPool 27 / PactSettler 28 / PactEvents 7 / PactErrors 30) in sync with the
  locked forge build. Deployed bytecode ABI == committed client ABI.
- Commits file-scoped: 46d2ab9 (1 file: script/Deploy.s.sol — the WP-EVM-01
  scaffold itself scopes the real deploy script to WP-07, NOT a contract
  source), 838c573 (addresses.ts + its co-located __tests__/addresses.test.ts;
  null->deployed, EIP-55, resolveDeployment env overlay intact — no mechanism
  change). NOT pushed. Tree clean (only expected untracked .claude/pr-reviews/
  + .planning/phases/07-*).
- TS18048 x17 in encode.test.ts: captain independently confirmed
  `git diff 07a79be..HEAD -- .../encode.test.ts` is EMPTY => genuinely
  pre-existing (a WP-06 artifact), NOT introduced by WP-07. Honest
  out-of-scope deviation, correctly flagged not fixed (file-scoped discipline).
  vitest 41/41 green.

## arcscan (C4 — honest outcome, independently corroborated)

Captain independently probed the arcscan getsourcecode API for PactRegistry:
ContractName=PactRegistry, CompilerVersion=v0.8.30+commit.73712a01,
SourceCode=13278 bytes, Verified=True. The report's per-contract evidence
(pool 5566 / settler 14352 bytes, same compiler, GUID "Pass - Verified") is
specific and consistent. Outcome is the BEST case — genuinely VERIFIED for all
three, not the documented-blocked fallback C4 allowed. The verification
narrative is honest and valuable: inline `--verify` (etherscan) failed BEFORE
any on-chain action (forge validates verifier config pre-broadcast; Arc 5042002
not in forge's etherscan registry; deployer nonce 0, NO orphan deploy, no
wasted gas), deploy was decoupled, success via `--verifier blockscout`
(arcscan is Blockscout-based). No foundry.toml / contract change. Recorded as
a reusable Arc tooling finding.

## All Gate A conditions honored

C1 (authority=deployer, branch removed) — VERIFIED on-chain. C2 (treasury &
empty template ratified, written record 07-C2-RATIFICATION.md, treasury==
deployer verified on-chain, maxTotalFeeBps 3000) — VERIFIED. C3 (read-only
5-call smoke required+sufficient; write smoke correctly skipped as optional) —
VERIFIED. C4 (honest arcscan outcome) — VERIFIED, best case. C5 (file-scoped
commits, not pushed, no PR comment, no pact installer, tree clean, contracts
untouched) — VERIFIED.

No defects. WP-EVM-07 is parity-faithful (contracts unchanged from the locked
WP-05/06 set), correctly deployed, verified, and honestly reported.

THE ARC EVM TRACK IS COMPLETE: WP-EVM-02 (errors/events/constants/
FeeValidation/PactRegistry), 03 (PactPool), 04 (PactSettler happy path),
05 (PactSettler hardening), 06 (TS client + fuzz/gas + parity matrix + spec
corrections), 07 (Arc Testnet deploy + arcscan verify). The Solana
pact-network-v1-pinocchio program is now ported to EVM at behavioral parity
AND live on Arc Testnet with verified source.

## Closeout (do these in order, then STOP — this is the FINAL WP of the track; do NOT spawn or start anything else)

1. Tracking: mark phase 07 complete + the Arc-EVM deploy milestone COMPLETE in
   ROADMAP / STATE (authored-at-turn; no gsd-verifier). If WP-07 has no
   pre-existing ROADMAP rows, add a concise "WP-EVM-07 Arc Testnet deploy —
   COMPLETE" entry with the 3 addresses.
2. PUSH: `git push origin feat/arc-protocol-v1` (commits 46d2ab9 + 838c573).
3. PR #204 comment — a WP-EVM-07 deploy-completion summary: the 3 deployed
   addresses + arcscan #code links, the blockscout-not-etherscan verifier
   tooling finding (for future Arc deploys), check:abi PASS both passes, the
   5/5 smoke, C1/C2 as-deployed (authority=treasury=deployer EOA, empty
   template, maxTotalFeeBps 3000), and the two carried non-blocking items
   (C2 mainnet treasury split; pre-existing TS18048 encode.test.ts hygiene).
   State clearly the Arc EVM track (WP-02..07) is now COMPLETE.
4. Extend docs/superpowers/handoffs/2026-05-18-arc-evm-port-handoff.md with a
   "WP-EVM-07 DEPLOY COMPLETE" section: the 3 addresses + chain id 5042002 +
   arcscan links; the blockscout verifier finding; that contracts remain
   LOCKED and unchanged (deploy added zero contract behavior); the C2
   mainnet-hardening carry (split treasury off the deployer EOA before any
   mainnet deploy — fresh deploy, no migration, treasuryVault has no setter);
   the pre-existing TS18048 hygiene carry. Keep ALL prior content intact.
   Commit file-scoped + include in the push.
5. Append a DONE-STATE block to 07-REPORT-gateB.md. Then STOP. Do NOT start
   anything else — the Arc EVM track is closed. The captain updates project
   memory and closes the crew; no further crew is spawned.
