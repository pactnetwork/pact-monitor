import { listChains } from "@pact-network/shared";
import { BadRequestException } from "@nestjs/common";

const KNOWN_NETWORKS = new Set(listChains().map((c) => c.network));

/**
 * Validate a `?network=` query-param value. Returns the validated string or
 * undefined (meaning "aggregate across networks").
 *
 * Throws 400 BadRequest if the value is non-empty but not in the registry.
 */
export function validateNetworkParam(
  raw: string | undefined,
): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (!KNOWN_NETWORKS.has(raw)) {
    throw new BadRequestException(
      `Unknown network "${raw}". Known: ${[...KNOWN_NETWORKS].sort().join(", ")}`,
    );
  }
  return raw;
}
