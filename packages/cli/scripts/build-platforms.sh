#!/usr/bin/env bash
# Build the per-platform `pact` binaries and scaffold one npm package per
# platform under dist-platforms/<key>/ (esbuild-style optionalDependencies).
#
#   dist-platforms/
#     linux-x64/      { package.json (os:linux cpu:x64), bin/pact, README.md }
#     linux-arm64/    ...
#     darwin-x64/     ...
#     darwin-arm64/   ...
#     windows-x64/    { package.json (os:win32 cpu:x64), bin/pact.exe, README.md }
#
# `bun build --compile --target=bun-<os>-<arch>` cross-compiles all of these
# from any host, so a single ubuntu runner produces every platform.
#
# Run from packages/cli/ (the publish workflow does; `pnpm build:platforms` cds here).
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
REPO_URL="https://github.com/pactnetwork/pact-monitor"
OUT_DIR="dist-platforms"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# key | bun --target | npm "os" | npm "cpu" | binary filename
TARGETS=(
  "linux-x64|bun-linux-x64|linux|x64|pact"
  "linux-arm64|bun-linux-arm64|linux|arm64|pact"
  "darwin-x64|bun-darwin-x64|darwin|x64|pact"
  "darwin-arm64|bun-darwin-arm64|darwin|arm64|pact"
  "windows-x64|bun-windows-x64|win32|x64|pact.exe"
)

for entry in "${TARGETS[@]}"; do
  IFS='|' read -r key bun_target npm_os npm_cpu bin_name <<<"$entry"
  pkg_dir="$OUT_DIR/$key"
  mkdir -p "$pkg_dir/bin"

  echo "==> building @q3labs/pact-cli-$key ($bun_target)"
  bun build src/index.ts --compile --target="$bun_target" --outfile "$pkg_dir/bin/$bin_name"
  chmod +x "$pkg_dir/bin/$bin_name" 2>/dev/null || true

  cat >"$pkg_dir/package.json" <<JSON
{
  "name": "@q3labs/pact-cli-$key",
  "version": "$VERSION",
  "description": "Prebuilt \`pact\` binary for $key. Installed automatically as an optional dependency of @q3labs/pact-cli.",
  "license": "MIT",
  "author": "Pact Network",
  "repository": { "type": "git", "url": "git+$REPO_URL.git", "directory": "packages/cli" },
  "homepage": "$REPO_URL/tree/main/packages/cli",
  "os": ["$npm_os"],
  "cpu": ["$npm_cpu"],
  "files": ["bin"],
  "publishConfig": { "access": "public" }
}
JSON

  cat >"$pkg_dir/README.md" <<MD
# @q3labs/pact-cli-$key

Prebuilt \`pact\` binary for **$key** ($npm_os/$npm_cpu).

This package is an implementation detail — it is installed automatically as an
optional dependency of [\`@q3labs/pact-cli\`](https://www.npmjs.com/package/@q3labs/pact-cli).
Install that instead:

\`\`\`bash
npm install -g @q3labs/pact-cli
\`\`\`

Source: $REPO_URL
MD

  echo "    -> $pkg_dir/bin/$bin_name ($(du -h "$pkg_dir/bin/$bin_name" | cut -f1))"
done

echo
echo "built ${#TARGETS[@]} platform packages under $OUT_DIR/ for version $VERSION"
