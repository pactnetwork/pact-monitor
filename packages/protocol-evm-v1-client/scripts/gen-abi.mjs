// Regenerate the committed src/abi/*.ts modules from the LOCKED contract set
// (forge artifacts + PactErrors.sol). Run at T1 and whenever the contracts
// legitimately change (they do not in WP-06 — additive-only). The drift guard
// (check-abi-drift.mjs) enforces these stay in sync.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ALL_ABIS, ABI_OUT_DIR, buildAbiMap, renderAbiModule } from "./abi-lib.mjs";

const map = buildAbiMap();
for (const name of ALL_ABIS) {
  const p = resolve(ABI_OUT_DIR, `${name}.ts`);
  writeFileSync(p, renderAbiModule(name, map[name]));
  console.log(`wrote ${p} (${map[name].length} abi items)`);
}
console.log("gen:abi OK");
