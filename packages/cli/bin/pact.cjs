#!/usr/bin/env node
// Cross-platform launcher for the bun-compiled `pact` binary.
//
// `bun build --compile` produces a platform-specific native executable, so
// `@q3labs/pact-cli` ships one tiny prebuilt package per platform
// (`@q3labs/pact-cli-<os>-<arch>`) declared as optionalDependencies. npm/pnpm
// install only the package whose `os`/`cpu` matches the host; this shim resolves
// it and execs it, forwarding argv / stdio / exit code verbatim.
"use strict";

const { spawnSync } = require("node:child_process");

const PLATFORM = process.platform === "win32" ? "windows" : process.platform; // 'darwin' | 'linux' | 'windows'
const ARCH = process.arch; // 'x64' | 'arm64'
const KEY = `${PLATFORM}-${ARCH}`;
const PKG = `@q3labs/pact-cli-${KEY}`;
const BIN_NAME = process.platform === "win32" ? "pact.exe" : "pact";

let binPath;
try {
  binPath = require.resolve(`${PKG}/bin/${BIN_NAME}`);
} catch {
  console.error(
    `@q3labs/pact-cli: no prebuilt binary for ${KEY}.\n` +
      `  Expected the optional dependency "${PKG}" to be installed.\n` +
      `  - If your package manager skipped it, reinstall without --no-optional.\n` +
      `  - Supported: linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64.\n` +
      `  - Otherwise build from source: https://github.com/pactnetwork/pact-monitor`,
  );
  process.exit(1);
}

const result = spawnSync(binPath, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(`@q3labs/pact-cli: failed to launch ${binPath}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
