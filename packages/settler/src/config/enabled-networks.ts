/**
 * Enabled-network helpers (multi-evm WP T5). Single source of truth for
 * parsing PACT_ENABLED_NETWORKS, so every boot-path provider gates its Solana
 * deps the same way the AdaptersService bootstrap does. Default mirrors the
 * adapters bootstrap: an unset value means solana-devnet.
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
