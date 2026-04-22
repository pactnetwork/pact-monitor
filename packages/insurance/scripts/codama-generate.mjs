// Codama → TS client regenerator for `src/generated/`.
//
// WP-5 state: only `initialize_protocol` is implemented on-chain, so the
// checked-in `src/generated/` files are hand-authored (the Shank CLI
// isn't available locally to emit a full IDL, and Codama's `nodesFromAnchor`
// adapter rejects a single-instruction stub). This script is the reproducible
// entry point — when the IDL under `packages/program/idl/pact_insurance.json`
// grows complete (WP-6..WP-15), flip `USE_CODAMA = true` and this will emit
// `src/generated/**` from the root node.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const IDL_PATH = resolve(ROOT, '../program/idl/pact_insurance.json');
const OUT_DIR = resolve(ROOT, 'src/generated');

const USE_CODAMA = false;

async function main() {
  const idlRaw = await readFile(IDL_PATH, 'utf-8');
  const idl = JSON.parse(idlRaw);
  const instructionCount = (idl.instructions ?? []).length;

  if (!USE_CODAMA) {
    console.log(
      `[codama] IDL has ${instructionCount} instruction(s). ` +
        `USE_CODAMA=false — leaving hand-authored surface in ${OUT_DIR} intact. ` +
        `Flip USE_CODAMA in scripts/codama-generate.mjs once the IDL covers all 11 instructions.`,
    );
    return;
  }

  // Pipeline for future WPs (WP-6..WP-15 extend the IDL per-instruction):
  //   const { rootNodeFromAnchor } = await import('@codama/nodes-from-anchor');
  //   const { renderVisitor } = await import('@codama/renderers-js');
  //   const { createFromRoot } = await import('codama');
  //   const codama = createFromRoot(rootNodeFromAnchor(idl));
  //   codama.accept(renderVisitor(OUT_DIR, { deleteFolderBeforeRendering: true }));
  throw new Error(
    'codama pipeline not yet enabled — set USE_CODAMA=true and add `@codama/nodes-from-anchor`.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
