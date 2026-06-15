// D-A ABI DRIFT GUARD (captain GATE-A CONDITION).
//
// The TDD suites verify the ABI against itself. THIS verifies the committed
// src/abi/*.ts against the ACTUAL locked contracts: it runs a fresh
// `forge build`, re-extracts every ABI (forge artifacts + the locked
// PactErrors.sol source), canonicalizes identically to gen-abi, and diffs
// against what is committed. ANY difference fails loudly (exit 1) — a stale
// committed ABI silently breaking client parity vs the locked contracts is
// the one real parity risk of the curated-ABI approach; this closes it.
//
// Run at T1 (post-scaffold), T7 (post-fuzz/gas), and T11 (GATE B).
import { execSync } from "node:child_process";
import {
  ALL_ABIS,
  CONTRACTS_DIR,
  buildAbiMap,
  readCommittedAbi,
} from "./abi-lib.mjs";

console.log(`[abi-drift] fresh forge build in ${CONTRACTS_DIR} ...`);
try {
  execSync("forge build", { cwd: CONTRACTS_DIR, stdio: "inherit" });
} catch (e) {
  console.error("[abi-drift] FAIL: `forge build` errored — cannot verify ABI sync.");
  process.exit(1);
}

const fresh = buildAbiMap();
let drift = false;
for (const name of ALL_ABIS) {
  const expected = JSON.stringify(fresh[name]);
  let committed;
  try {
    committed = JSON.stringify(readCommittedAbi(name));
  } catch (e) {
    console.error(`[abi-drift] FAIL: ${name}: ${e.message}`);
    drift = true;
    continue;
  }
  if (expected !== committed) {
    drift = true;
    console.error(
      `[abi-drift] FAIL: ${name} committed ABI is OUT OF SYNC with the locked contracts.\n` +
        `  Fresh build produced a different ABI than packages/protocol-evm-v1-client/src/abi/${name}.ts.\n` +
        `  If the contract change is intended and captain-authorized, run gen:abi and re-review;\n` +
        `  otherwise this is an unauthorized WP-02..05 contract drift — HALT and escalate.`,
    );
  } else {
    console.log(`[abi-drift] OK: ${name} (${fresh[name].length} items) in sync`);
  }
}
if (drift) process.exit(1);
console.log("[abi-drift] PASS: all committed ABIs in sync with the locked forge build");
