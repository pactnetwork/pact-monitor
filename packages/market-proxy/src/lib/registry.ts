import type { EndpointHandler } from "../endpoints/types.js";
import { heliusHandler } from "../endpoints/helius.js";
import { birdeyeHandler } from "../endpoints/birdeye.js";
import { jupiterHandler } from "../endpoints/jupiter.js";
import { elfaHandler } from "../endpoints/elfa.js";
import { falHandler } from "../endpoints/fal.js";
import { dummyHandler } from "../endpoints/dummy.js";

export const handlerRegistry: Record<string, EndpointHandler> = {
  helius: heliusHandler,
  birdeye: birdeyeHandler,
  jupiter: jupiterHandler,
  elfa: elfaHandler,
  fal: falHandler,
  // Demo upstream — https://dummy.pactnetwork.io. Plain HTTP, status-based
  // classifier. See ../endpoints/dummy.ts and docs/premium-coverage-mvp.md.
  dummy: dummyHandler,
};
