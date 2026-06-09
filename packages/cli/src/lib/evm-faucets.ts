// Known EVM networks the Pact CLI can route to via --network <name>.
// Adding a network here both (a) declares the faucet URL printed in the
// halt-on-first-gen hint and (b) marks the name as EVM so loadEvmWallet runs
// instead of the Solana loader. Mainnet entries point at "—" (no faucet) so
// the gen flow still prints something coherent if a user ever runs against
// production from a fresh box.
export const EVM_FAUCETS: Record<string, string> = {
  "arc-testnet": "https://faucet.circle.com",
  "base-sepolia": "https://www.alchemy.com/faucets/base-sepolia",
  "base-mainnet": "—",
  "arc-mainnet": "—",
};

export function isEvmNetwork(name: string | undefined | null): name is string {
  return typeof name === "string" && name in EVM_FAUCETS;
}

export function faucetForNetwork(name: string): string | undefined {
  return EVM_FAUCETS[name];
}
