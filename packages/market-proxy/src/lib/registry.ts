import type { EndpointHandler } from "../endpoints/types.js";
import { heliusHandler } from "../endpoints/helius.js";
import { birdeyeHandler } from "../endpoints/birdeye.js";
import { jupiterHandler } from "../endpoints/jupiter.js";

export const handlerRegistry: Record<string, EndpointHandler> = {
  helius: heliusHandler,
  birdeye: birdeyeHandler,
  jupiter: jupiterHandler,
};
