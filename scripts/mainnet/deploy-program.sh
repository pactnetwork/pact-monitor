#!/usr/bin/env bash
#
# deploy-program.sh — one-shot mainnet program deploy from your laptop.
#
# Runs every check the deploy runbook prescribes, then either deploys or
# bails loudly with remediation. Safe to re-run: idempotent up to the
# `solana program deploy` line, which itself resumes from any orphaned buffer.
#
# Usage:
#   ./deploy-program.sh [--keys-dir PATH] [--rpc-url URL] [--repo PATH] [--yes] [--dry-run]
#
# Defaults:
#   --keys-dir  ~/pact-mainnet-keys
#   --rpc-url   https://api.mainnet-beta.solana.com
#   --repo      auto-detected: dirname of this script's parent
#   --yes       OFF (script prompts y/N before sending the deploy tx)
#   --dry-run   OFF (skips the actual deploy; runs all checks + build only)
#
# Examples:
#   ./deploy-program.sh
#   ./deploy-program.sh --rpc-url "https://solana-mainnet.g.alchemy.com/v2/$ALCHEMY_KEY"
#   ./deploy-program.sh --dry-run
#   ./deploy-program.sh --yes  # skip confirmation prompt

set -euo pipefail

# -----------------------------------------------------------------------------
# Constants — these are the canonical mainnet identifiers. Don't change.
# -----------------------------------------------------------------------------
MAINNET_PROGRAM_ID="5bCJcdWdKLJ7arrMVMFh3z99rQDxV785fnD9XGcr3xwc"
MAINNET_UPGRADE_AUTH="JB7rp9wMerZbP3yQLL8ZJx5kxRxvhkcfEzaAhuG5uThL"
EXPECTED_BINARY_BYTES=88680
EXPECTED_BINARY_BYTES_TOLERANCE=1024  # ±1KB to allow for minor compile diffs
MIN_SOL_LAMPORTS=1000000000  # 1.0 SOL — covers ~0.62 SOL rent + ~0.05 init + ~0.3 buffer

# -----------------------------------------------------------------------------
# Defaults
# -----------------------------------------------------------------------------
KEYS_DIR="${HOME}/pact-mainnet-keys"
RPC_URL="https://api.mainnet-beta.solana.com"
REPO_PATH=""  # auto-detect below
ASSUME_YES=0
DRY_RUN=0

# -----------------------------------------------------------------------------
# Color helpers
# -----------------------------------------------------------------------------
if [[ -t 1 ]]; then
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  YELLOW=$'\033[33m'
  BLUE=$'\033[34m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
else
  RED= GREEN= YELLOW= BLUE= BOLD= RESET=
fi

err()  { echo "${RED}${BOLD}ERROR:${RESET} $*" >&2; }
warn() { echo "${YELLOW}${BOLD}WARN:${RESET}  $*" >&2; }
ok()   { echo "${GREEN}OK:${RESET}    $*"; }
step() { echo; echo "${BLUE}${BOLD}=>${RESET} ${BOLD}$*${RESET}"; }
info() { echo "       $*"; }

die() {
  err "$1"
  if [[ -n "${2:-}" ]]; then
    echo
    echo "${YELLOW}Fix:${RESET} $2" >&2
  fi
  exit 1
}

# -----------------------------------------------------------------------------
# Argv parsing
# -----------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keys-dir) KEYS_DIR="$2"; shift 2 ;;
    --rpc-url)  RPC_URL="$2";  shift 2 ;;
    --repo)     REPO_PATH="$2"; shift 2 ;;
    --yes|-y)   ASSUME_YES=1; shift ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,/^set/p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *) die "unknown arg: $1" "see --help" ;;
  esac
done

# Auto-detect repo path: this script lives in <repo>/scripts/mainnet/
if [[ -z "$REPO_PATH" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO_PATH="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi

PROGRAM_KEY="${KEYS_DIR}/pact-network-v1-program-keypair.json"
UPGRADE_KEY="${KEYS_DIR}/pact-mainnet-upgrade-authority.json"
PROGRAM_DIR="${REPO_PATH}/packages/program/programs-pinocchio/pact-network-v1-pinocchio"
BINARY_PATH="${REPO_PATH}/packages/program/target/deploy/pact_network_v1.so"
LIB_RS="${PROGRAM_DIR}/src/lib.rs"

# -----------------------------------------------------------------------------
# Header
# -----------------------------------------------------------------------------
cat <<EOF

${BOLD}Pact Network V1 — Mainnet Program Deploy${RESET}
${BOLD}=========================================${RESET}

  Repo path:  $REPO_PATH
  Keys dir:   $KEYS_DIR
  RPC URL:    $RPC_URL
  Mode:       $([ $DRY_RUN -eq 1 ] && echo "${YELLOW}DRY RUN (no tx sent)${RESET}" || echo "${RED}REAL (tx will land on mainnet)${RESET}")

EOF

# -----------------------------------------------------------------------------
# 1. Tool checks
# -----------------------------------------------------------------------------
step "1/8  Checking required tools"

command -v solana >/dev/null 2>&1 \
  || die "solana CLI not found in PATH" "install: sh -c \"\$(curl -sSfL https://release.solana.com/stable/install)\""
ok "solana: $(solana --version | head -1)"

command -v rustc >/dev/null 2>&1 \
  || die "rustc not found" "install rustup: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
ok "rustc: $(rustc --version | head -1)"

command -v cargo-build-sbf >/dev/null 2>&1 \
  || die "cargo-build-sbf not found" "comes with solana CLI; reinstall solana"
ok "cargo-build-sbf: $(cargo-build-sbf --version | head -1)"

# -----------------------------------------------------------------------------
# 2. Repo + source checks
# -----------------------------------------------------------------------------
step "2/8  Checking repo + source"

[[ -d "$REPO_PATH/.git" ]] \
  || die "no git repo at $REPO_PATH" "use --repo PATH or run from inside the pact-monitor checkout"

[[ -d "$PROGRAM_DIR" ]] \
  || die "program source not found at $PROGRAM_DIR" "are you on the develop branch with pact-network-v1 in place?"

[[ -f "$LIB_RS" ]] \
  || die "lib.rs not found at $LIB_RS" "the pinocchio v1 program crate is missing"

# Verify declare_id! is mainnet (portable sed — works on BSD/macOS + GNU)
declared_id="$(sed -nE 's/.*declare_id!\("([^"]+)"\).*/\1/p' "$LIB_RS" | head -1)"
if [[ "$declared_id" != "$MAINNET_PROGRAM_ID" ]]; then
  die "lib.rs declare_id! is '$declared_id', expected '$MAINNET_PROGRAM_ID'" \
      "you're on the wrong branch or build. checkout 'develop' and 'git pull'"
fi
ok "declare_id matches mainnet: $MAINNET_PROGRAM_ID"

# -----------------------------------------------------------------------------
# 3. Keypair checks
# -----------------------------------------------------------------------------
step "3/8  Checking keypairs"

[[ -d "$KEYS_DIR" ]] \
  || die "keys dir not found: $KEYS_DIR" "mkdir -p $KEYS_DIR && chmod 700 $KEYS_DIR; place keypairs there"

# Permission sanity check (warn, don't fail — different umasks across OS)
keys_dir_perm="$(stat -c '%a' "$KEYS_DIR" 2>/dev/null || stat -f '%Lp' "$KEYS_DIR" 2>/dev/null)"
[[ "$keys_dir_perm" == "700" ]] \
  || warn "keys dir perms are $keys_dir_perm (recommend 700): chmod 700 $KEYS_DIR"

[[ -f "$PROGRAM_KEY" ]] \
  || die "program keypair not found: $PROGRAM_KEY" "this is the canonical mainnet program ID keypair. do NOT generate a new one."
[[ -f "$UPGRADE_KEY" ]] \
  || die "upgrade-authority keypair not found: $UPGRADE_KEY" "this is the canonical mainnet upgrade-authority keypair. do NOT generate a new one."

prog_pubkey="$(solana-keygen pubkey "$PROGRAM_KEY")"
upgr_pubkey="$(solana-keygen pubkey "$UPGRADE_KEY")"

[[ "$prog_pubkey" == "$MAINNET_PROGRAM_ID" ]] \
  || die "program keypair pubkey is $prog_pubkey, expected $MAINNET_PROGRAM_ID" \
         "wrong keypair file at $PROGRAM_KEY. STOP and verify before continuing."

[[ "$upgr_pubkey" == "$MAINNET_UPGRADE_AUTH" ]] \
  || die "upgrade-authority pubkey is $upgr_pubkey, expected $MAINNET_UPGRADE_AUTH" \
         "wrong keypair file at $UPGRADE_KEY. STOP and verify before continuing."

ok "program keypair: $prog_pubkey"
ok "upgrade authority: $upgr_pubkey"

# -----------------------------------------------------------------------------
# 4. Balance check
# -----------------------------------------------------------------------------
step "4/8  Checking upgrade-authority SOL balance"

balance_lamports="$(solana balance "$upgr_pubkey" --url "$RPC_URL" --lamports 2>/dev/null | awk '{print $1}')"
[[ -n "$balance_lamports" && "$balance_lamports" =~ ^[0-9]+$ ]] \
  || die "couldn't read balance for $upgr_pubkey via $RPC_URL" "check RPC URL is reachable: curl $RPC_URL"

balance_sol="$(awk -v l="$balance_lamports" 'BEGIN { printf "%.4f", l / 1e9 }')"
if [[ "$balance_lamports" -lt "$MIN_SOL_LAMPORTS" ]]; then
  die "upgrade-authority has $balance_sol SOL — need ≥$(awk -v l="$MIN_SOL_LAMPORTS" 'BEGIN{printf "%.1f", l/1e9}') SOL" \
      "send more SOL to $upgr_pubkey on mainnet, then re-run"
fi
ok "balance: $balance_sol SOL on $upgr_pubkey"

# -----------------------------------------------------------------------------
# 5. Build SBF binary
# -----------------------------------------------------------------------------
step "5/8  Building SBF binary (cargo build-sbf --features bpf-entrypoint)"

cd "$PROGRAM_DIR"
info "from: $PROGRAM_DIR"

# Clean only the .so artifact to force a fresh link, but keep dep cache for speed
rm -f "$BINARY_PATH"

cargo build-sbf --features bpf-entrypoint 2>&1 | tail -10

[[ -f "$BINARY_PATH" ]] \
  || die "binary not produced at $BINARY_PATH" "check cargo output above for errors"

binary_bytes="$(stat -c '%s' "$BINARY_PATH" 2>/dev/null || stat -f '%z' "$BINARY_PATH" 2>/dev/null)"
diff_bytes=$(( binary_bytes > EXPECTED_BINARY_BYTES ? binary_bytes - EXPECTED_BINARY_BYTES : EXPECTED_BINARY_BYTES - binary_bytes ))

if [[ $binary_bytes -lt 50000 ]]; then
  die "binary is only $binary_bytes bytes (expected ~$EXPECTED_BINARY_BYTES)" \
      "you built the stub. verify '--features bpf-entrypoint' was passed; rebuild."
fi
if [[ $diff_bytes -gt $EXPECTED_BINARY_BYTES_TOLERANCE ]]; then
  warn "binary is $binary_bytes bytes; expected ~$EXPECTED_BINARY_BYTES (drift: $diff_bytes bytes). proceeding."
else
  ok "binary size: $binary_bytes bytes (matches expected ~$EXPECTED_BINARY_BYTES)"
fi

cd - >/dev/null

# -----------------------------------------------------------------------------
# 6. Existing program check
# -----------------------------------------------------------------------------
step "6/8  Checking if program is already deployed"

# `solana program show` exits non-zero if the account doesn't exist
if solana program show "$MAINNET_PROGRAM_ID" --url "$RPC_URL" >/tmp/pact-program-show.txt 2>&1; then
  existing_authority="$(awk '/^Authority:/{print $2; exit}' /tmp/pact-program-show.txt)"
  existing_size="$(awk '/^Data Length:/{print $3; exit}' /tmp/pact-program-show.txt)"

  if [[ "$existing_authority" != "$MAINNET_UPGRADE_AUTH" ]]; then
    die "program at $MAINNET_PROGRAM_ID exists with WRONG authority: $existing_authority" \
        "expected $MAINNET_UPGRADE_AUTH. STOP — someone else owns this program ID."
  fi

  warn "program already deployed at $MAINNET_PROGRAM_ID (Data Length: $existing_size bytes)"
  warn "this run will perform an UPGRADE, replacing the on-chain binary"
  echo
else
  ok "no existing program at $MAINNET_PROGRAM_ID — initial deploy"
fi
rm -f /tmp/pact-program-show.txt

# -----------------------------------------------------------------------------
# 7. Confirmation
# -----------------------------------------------------------------------------
step "7/8  Confirmation"

cat <<EOF
About to ${RED}${BOLD}DEPLOY ON MAINNET${RESET}:
  Program ID:        $MAINNET_PROGRAM_ID
  Upgrade authority: $MAINNET_UPGRADE_AUTH (signing)
  Binary:            $BINARY_PATH ($binary_bytes bytes)
  RPC URL:           $RPC_URL
  Spending:          ~0.62 SOL rent + ~0.005 SOL tx fees on initial deploy
                     (no --max-len; ProgramData sized to binary. To grow
                     binary later: \`solana program extend <PROG_ID> <BYTES>\`.)

EOF

if [[ $DRY_RUN -eq 1 ]]; then
  ok "DRY_RUN — would deploy now. Skipping the actual tx."
  echo
  ok "All preflight checks passed. Re-run without --dry-run to deploy for real."
  exit 0
fi

if [[ $ASSUME_YES -ne 1 ]]; then
  read -r -p "Type 'yes' to proceed: " confirm
  if [[ "$confirm" != "yes" ]]; then
    die "aborted by user (typed: '$confirm')" "deploy not attempted; no SOL spent"
  fi
fi

# -----------------------------------------------------------------------------
# 8. Deploy
# -----------------------------------------------------------------------------
step "8/8  Deploying to mainnet"

# Use --keypair to override solana config so this script doesn't depend on
# whatever the user has set globally.
if ! solana program deploy \
       --url "$RPC_URL" \
       --keypair "$UPGRADE_KEY" \
       --program-id "$PROGRAM_KEY" \
       "$BINARY_PATH" \
       2>&1 | tee /tmp/pact-deploy.log
then
  err "deploy command failed — see output above"
  echo
  if grep -qi "Account allocation failed" /tmp/pact-deploy.log; then
    cat <<EOF >&2
${YELLOW}This usually means out-of-SOL during the multi-tx upload.
Send 0.5 SOL more to $upgr_pubkey, then re-run this script. Solana CLI
will resume from the on-chain buffer, so you don't pay for the upload twice.${RESET}
EOF
  elif grep -qi "Custom program error: 0x1" /tmp/pact-deploy.log; then
    cat <<EOF >&2
${YELLOW}declare_id! mismatch. The keypair pubkey doesn't match what's baked
into the binary. STOP — verify the program-keypair file before retrying.${RESET}
EOF
  elif grep -qi "429" /tmp/pact-deploy.log; then
    cat <<EOF >&2
${YELLOW}RPC rate-limited. Re-run with your Alchemy URL:
  $0 --rpc-url "https://solana-mainnet.g.alchemy.com/v2/\$ALCHEMY_KEY"${RESET}
EOF
  fi
  exit 1
fi

# Capture deploy signature from output
deploy_sig="$(awk '/^Signature:/{print $2; exit}' /tmp/pact-deploy.log || true)"
[[ -z "$deploy_sig" ]] && warn "couldn't parse deploy signature from output (deploy still may have succeeded — verify below)"

echo
ok "deploy command exited cleanly"
[[ -n "$deploy_sig" ]] && ok "signature: $deploy_sig"

# -----------------------------------------------------------------------------
# Verify
# -----------------------------------------------------------------------------
step "Verification"

sleep 2  # give the RPC a moment to confirm

if ! solana program show "$MAINNET_PROGRAM_ID" --url "$RPC_URL" >/tmp/pact-verify.txt 2>&1; then
  die "post-deploy 'solana program show' failed" "the deploy may have landed; check Solana Explorer: https://explorer.solana.com/address/$MAINNET_PROGRAM_ID"
fi

verify_authority="$(awk '/^Authority:/{print $2; exit}' /tmp/pact-verify.txt)"
verify_size="$(awk '/^Data Length:/{print $3; exit}' /tmp/pact-verify.txt)"

[[ "$verify_authority" == "$MAINNET_UPGRADE_AUTH" ]] \
  || die "post-deploy authority check FAILED: $verify_authority != $MAINNET_UPGRADE_AUTH" \
         "tx may have landed but with wrong authority. Investigate before init."

if [[ -n "$verify_size" ]] && [[ $verify_size -lt 50000 ]]; then
  warn "on-chain Data Length is $verify_size bytes — looks like the stub binary made it on-chain"
  warn "rebuild with --features bpf-entrypoint and redeploy"
  exit 1
fi

rm -f /tmp/pact-verify.txt /tmp/pact-deploy.log

ok "Authority correct: $verify_authority"
ok "Data Length: $verify_size bytes"

cat <<EOF

${GREEN}${BOLD}=== DEPLOY SUCCEEDED ===${RESET}

  Program ID:    $MAINNET_PROGRAM_ID
  Authority:     $MAINNET_UPGRADE_AUTH
  Binary size:   $verify_size bytes
EOF
[[ -n "$deploy_sig" ]] && echo "  Signature:     $deploy_sig"
cat <<EOF
  Explorer:      https://explorer.solana.com/address/$MAINNET_PROGRAM_ID

${BOLD}Next:${RESET}
  cd $REPO_PATH/scripts/mainnet
  bun install
  DRY_RUN=1 MAINNET_RPC_URL='$RPC_URL' bun init    # rehearsal
  MAINNET_RPC_URL='$RPC_URL' bun init              # real init (8 txs)

EOF
