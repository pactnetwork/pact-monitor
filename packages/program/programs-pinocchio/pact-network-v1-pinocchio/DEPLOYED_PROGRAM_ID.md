# Deployed Program ID

**Network:** Solana Devnet  
**Program ID:** `DhWibM2z3Vwp5VmJyashoeZCAZHLFKeHab8o12qYsiQc`  
**Deploy signature:** `3fAHvt3ditKuB6tiCE2ZTsiUcB5jFTuRToouCR9ze19MmpU3Fm86jxHrTVmRLFTybb7YPysZo2t5hCd6fiVHkdoM`  
**Deploy date:** 2026-05-05  
**Binary size:** 59,624 bytes (~58 KB)

## Pending redeploy (Step C refactor)

The `feat/pact-market-program` branch carries the substantive Step C refactor
(per-endpoint coverage pools, SPL Token approval-based agent custody,
interchangeable fee recipients with pool-as-residual + Treasury +
ProtocolConfig). The on-chain account/instruction shapes have changed
incompatibly with the deployed binary above — a redeploy at the same program
ID is required before any client can talk to the new code path.

**Status:** awaiting redeploy. The orchestrator (Alan) handles the redeploy
step out-of-band after the refactor PR (#61) lands. The upgrade authority
keypair is intact.

After the redeploy lands, update the binary size + deploy signature/date
above to reflect the new artifact.
