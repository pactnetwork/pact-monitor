// Slug -> public hostnames the CLI maps user-supplied URLs against.
//
// This map is the source of truth for the `/.well-known/endpoints` discovery
// payload until the Endpoint table grows a `hostnames` column. The CLI
// (packages/cli/src/lib/discovery.ts) calls fetch() on these hostnames; the
// gateway then routes the request to /v1/<slug>/* via the matched slug.
//
// Add new providers here when they ship in handlerRegistry. Hostnames must
// match exactly what callers will type — punycode form, no trailing dot.

export const PROVIDER_HOSTNAMES: Record<string, string[]> = {
  helius: ["api.helius.xyz", "mainnet.helius-rpc.com"],
  birdeye: ["public-api.birdeye.so"],
  jupiter: ["api.jup.ag", "lite-api.jup.ag", "quote-api.jup.ag"],
  elfa: ["api.elfa.ai"],
  fal: ["fal.run", "queue.fal.run"],
};

export function hostnamesForSlug(slug: string): string[] {
  return PROVIDER_HOSTNAMES[slug] ?? [];
}
