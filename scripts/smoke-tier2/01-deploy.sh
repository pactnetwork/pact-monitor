#!/usr/bin/env bash
# 01-deploy.sh — sed-replace declare_id! in lib.rs, rebuild SBF, deploy to surfpool,
# then revert lib.rs.
#
# REQUIREMENTS
#   - surfpool already running on http://127.0.0.1:8899 (run `surfpool start --network devnet --no-tui`)
#   - 00-setup.ts already ran (so .smoke-keys/program.json exists)
#   - $REPO_ROOT/packages/program/programs-pinocchio/pact-network-v1-pinocchio source tree
#     is present in this worktree. If only `pact-insurance-pinocchio` is here, this script
#     copies the V1 program crate from origin/feat/pact-market-program into a sibling dir
#     of `programs-pinocchio/` BEFORE building. Copy is uncommitted (gitignored under
#     packages/program/target/).
#
# SAFETY
#   - The lib.rs declare_id! rewrite is reverted in a `trap` cleanup so the
#     working tree is never left dirty after a failed build.
#   - The freshly deployed program ID == the one in `.smoke-keys/program.json`,
#     which is gitignored. The test program ID never enters git history.
#
# USAGE
#   bash scripts/smoke-tier2/01-deploy.sh

set -euo pipefail

SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SMOKE_DIR/../.." && pwd)"
KEYS_DIR="$SMOKE_DIR/.smoke-keys"
LOGS_DIR="$SMOKE_DIR/.logs"
mkdir -p "$LOGS_DIR"

PROGRAM_KEYPAIR="$KEYS_DIR/program.json"
UPGRADE_AUTHORITY_KEYPAIR="$KEYS_DIR/upgrade-authority.json"

if [[ ! -f "$PROGRAM_KEYPAIR" ]]; then
  echo "ERROR: $PROGRAM_KEYPAIR missing — run 00-setup.ts first" >&2
  exit 1
fi
if [[ ! -f "$UPGRADE_AUTHORITY_KEYPAIR" ]]; then
  echo "ERROR: $UPGRADE_AUTHORITY_KEYPAIR missing — run 00-setup.ts first" >&2
  exit 1
fi

PROGRAM_PUBKEY="$(solana-keygen pubkey "$PROGRAM_KEYPAIR")"
echo "Test program ID: $PROGRAM_PUBKEY"

# 1. Make sure the V1 crate is present in this worktree. If only the
#    pact-insurance-pinocchio crate is checked out (settler branch state),
#    we need to fetch the V1 sources from feat/pact-market-program.
PROGRAM_DIR="$REPO_ROOT/packages/program/programs-pinocchio/pact-network-v1-pinocchio"
if [[ ! -d "$PROGRAM_DIR" ]]; then
  echo "V1 program crate not present in this worktree — extracting from origin/feat/pact-market-program"
  mkdir -p "$REPO_ROOT/packages/program/programs-pinocchio"
  TMP_TAR="$(mktemp -t pactv1.XXXXXX.tar)"
  git -C "$REPO_ROOT" archive origin/feat/pact-market-program \
      packages/program/programs-pinocchio/pact-network-v1-pinocchio \
      > "$TMP_TAR"
  ( cd "$REPO_ROOT" && tar -xf "$TMP_TAR" )
  rm -f "$TMP_TAR"
fi

LIB_RS="$PROGRAM_DIR/src/lib.rs"
ORIG_DECLARE_ID_LINE="$(grep -n 'solana_address::declare_id!' "$LIB_RS" | head -1 || true)"
if [[ -z "$ORIG_DECLARE_ID_LINE" ]]; then
  echo "ERROR: declare_id! line not found in $LIB_RS" >&2
  exit 1
fi
ORIG_BACKUP="$LIB_RS.smoke-tier2.bak"
cp "$LIB_RS" "$ORIG_BACKUP"

restore_lib_rs() {
  if [[ -f "$ORIG_BACKUP" ]]; then
    mv "$ORIG_BACKUP" "$LIB_RS"
    echo "Reverted $LIB_RS"
  fi
}
trap restore_lib_rs EXIT

# 2. sed-replace the declare_id! constant.
echo "Rewriting declare_id! in $LIB_RS to $PROGRAM_PUBKEY"
sed -i.tmp "s|solana_address::declare_id!(\"[^\"]*\")|solana_address::declare_id!(\"$PROGRAM_PUBKEY\")|" "$LIB_RS"
rm -f "$LIB_RS.tmp"
grep "declare_id!" "$LIB_RS"

# 3. Build the SBF binary.
echo "Building SBF binary (this may take a few minutes on a cold cache)"
(
  cd "$PROGRAM_DIR"
  cargo build-sbf --features bpf-entrypoint 2>&1 | tee "$LOGS_DIR/sbf-build.log"
)

BIN="$REPO_ROOT/packages/program/target/deploy/pact_network_v1.so"
if [[ ! -f "$BIN" ]]; then
  echo "ERROR: SBF build did not produce $BIN" >&2
  exit 1
fi
ls -la "$BIN"

# 4. Deploy to surfpool. Use --upgrade-authority + --program-id flags so the
#    deploy lands at the test program ID and the upgrade authority is the
#    locally generated key (gitignored).
echo "Deploying to http://127.0.0.1:8899"
solana --url http://127.0.0.1:8899 program deploy \
  --program-id "$PROGRAM_KEYPAIR" \
  --upgrade-authority "$UPGRADE_AUTHORITY_KEYPAIR" \
  --keypair "$UPGRADE_AUTHORITY_KEYPAIR" \
  "$BIN" 2>&1 | tee "$LOGS_DIR/deploy.log"

# 5. Verify
echo "Verifying program account"
solana --url http://127.0.0.1:8899 program show "$PROGRAM_PUBKEY"

echo "== smoke-tier2/01-deploy OK =="
