export const ENDPOINT_SLUGS = ["helius", "birdeye", "jupiter", "elfa", "fal"] as const;

export type EndpointSlug = (typeof ENDPOINT_SLUGS)[number];
