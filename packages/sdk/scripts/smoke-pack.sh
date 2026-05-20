#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TMP_DIR="$(mktemp -d)"
GENERATED_TARBALLS=()
cleanup() {
  rm -rf "$TMP_DIR"
  if ((${#GENERATED_TARBALLS[@]})); then
    rm -f "${GENERATED_TARBALLS[@]}"
  fi
}
trap cleanup EXIT

pack_package() {
  local package_dir="$1"
  local package_name
  package_name="$(node -p "require('${ROOT_DIR}/${package_dir}/package.json').name")"
  local output
  output="$(cd "${ROOT_DIR}/${package_dir}" && pnpm pack)"
  local tarball
  tarball="$(printf '%s\n' "$output" | tail -n 1)"
  if [[ "$tarball" != /* ]]; then
    tarball="${ROOT_DIR}/${package_dir}/${tarball}"
  fi
  if [[ ! -f "$tarball" ]]; then
    echo "::error::${package_name} pack did not create tarball at ${tarball}" >&2
    exit 1
  fi
  printf '%s\n' "$tarball"
}

assert_no_workspace_deps() {
  local tarball="$1"
  tar -xzOf "$tarball" package/package.json | node -e '
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync(0, "utf8"));
const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const bad = [];
for (const section of sections) {
  for (const [name, version] of Object.entries(pkg[section] ?? {})) {
    if (String(version).startsWith("workspace:")) {
      bad.push(`${section}.${name}=${version}`);
    }
  }
}
if (bad.length) {
  console.error(`workspace protocol leaked into ${pkg.name}: ${bad.join(", ")}`);
  process.exit(1);
}
'
}

PROTOCOL_TARBALL="$(pack_package "packages/protocol-v1-client")"
SDK_TARBALL="$(pack_package "packages/sdk")"
GENERATED_TARBALLS=("$PROTOCOL_TARBALL" "$SDK_TARBALL")

assert_no_workspace_deps "$PROTOCOL_TARBALL"
assert_no_workspace_deps "$SDK_TARBALL"

mkdir -p "$TMP_DIR/consumer"
cd "$TMP_DIR/consumer"
npm init -y >/dev/null
npm install "$PROTOCOL_TARBALL" "$SDK_TARBALL"

cat > smoke.mjs <<'EOF'
import { createPact } from "@pact-network/sdk";

if (typeof createPact !== "function") {
  throw new Error(`expected createPact to be a function, got ${typeof createPact}`);
}

console.log("ok createPact is", typeof createPact);
EOF

node smoke.mjs
