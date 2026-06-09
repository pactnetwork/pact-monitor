/**
 * Enabled-network helpers — local copy of the settler's
 * packages/settler/src/config/enabled-networks.ts. The indexer cannot import
 * from the settler package, so this mirrors it verbatim (agent-tasks#14). Single
 * source of truth within the indexer for parsing PACT_ENABLED_NETWORKS, so every
 * boot-path provider gates its Solana deps the same way the AdaptersService
 * bootstrap does. Default mirrors the adapters bootstrap: an unset value means
 * solana-devnet.
 */

export function parseEnabledNetworks(raw: string | undefined): string[] {
  return (raw ?? "solana-devnet")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True iff PACT_ENABLED_NETWORKS includes at least one solana-* network. */
export function hasSolanaNetwork(raw: string | undefined): boolean {
  return parseEnabledNetworks(raw).some((n) => n.startsWith("solana"));
}
