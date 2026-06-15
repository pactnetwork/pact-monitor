#!/usr/bin/env node
// Replace bun's auto-injected `#!/usr/bin/env bun` + `// @bun` lines
// with a `#!/usr/bin/env node` shebang so the bundled CLI runs under
// Node without needing Bun on the user's host. `bun build --target=node`
// produces Node-compatible JS but still stamps a bun shebang on the
// emitted file; `--banner` adds AFTER that, not in place of it. Easier
// to fix in a tiny post-build step than to fight the bundler.

import { readFileSync, writeFileSync } from "node:fs";

const [, , file] = process.argv;
if (!file) {
  console.error("usage: fix-shebang.mjs <file>");
  process.exit(1);
}

const src = readFileSync(file, "utf8");
const lines = src.split("\n");

// Drop leading shebang/marker lines that came from bun.
let drop = 0;
while (drop < lines.length) {
  const l = lines[drop];
  if (l.startsWith("#!") || l === "// @bun") {
    drop++;
    continue;
  }
  break;
}

const out = ["#!/usr/bin/env node", ...lines.slice(drop)].join("\n");
writeFileSync(file, out);
