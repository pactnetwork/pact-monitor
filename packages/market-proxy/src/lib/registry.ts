import type { EndpointHandler } from "../endpoints/types.js";
import { heliusHandler } from "../endpoints/helius.js";
import { birdeyeHandler } from "../endpoints/birdeye.js";
import { jupiterHandler } from "../endpoints/jupiter.js";
import { elfaHandler } from "../endpoints/elfa.js";
import { falHandler } from "../endpoints/fal.js";
import { moralisHandler } from "../endpoints/moralis.js";
import { covalentHandler } from "../endpoints/covalent.js";
import { dummyHandler } from "../endpoints/dummy.js";

export const handlerRegistry: Record<string, EndpointHandler> = {
  helius: heliusHandler,
  birdeye: birdeyeHandler,
  jupiter: jupiterHandler,
  elfa: elfaHandler,
  fal: falHandler,
  moralis: moralisHandler,
  covalent: covalentHandler,
  // Demo upstream — https://dummy.pactnetwork.io. Plain HTTP, status-based
  // classifier. See ../endpoints/dummy.ts and docs/premium-coverage-mvp.md.
  dummy: dummyHandler,
};
