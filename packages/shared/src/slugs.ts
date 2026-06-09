export const ENDPOINT_SLUGS = [
  "helius",
  "birdeye",
  "jupiter",
  "elfa",
  "fal",
  "moralis",
  "covalent",
] as const;

export type EndpointSlug = (typeof ENDPOINT_SLUGS)[number];
