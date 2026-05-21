/**
 * `@q3labs/pact-sdk/merchant` — the merchant-side surface of the Pact SDK.
 *
 * Consumed by API providers who want to wrap their endpoints in Pact Network
 * insurance, receive premiums per call, attribute calls to insured agents,
 * and (later) earn revshare on referred agents.
 */
export { createPactMerchant } from "./factory.js";
export type {
  MerchantInstance,
  MerchantConfig,
  ObservationInput,
  ObservationResult,
  RegisterInput,
  RegisterResult,
  MerchantStats,
  DisputeInput,
  DisputeResult,
  MerchantReferrals,
  MiddlewareOptions,
  PricingMap,
  ClassifyResponseFn,
} from "./factory.js";

export {
  canonicalProxiedByMessage,
  signProxiedBy,
  verifyProxiedBy,
  PROXIED_BY_DOMAIN,
  type ProxiedByMessage,
} from "./attestation.js";

export {
  defaultClassify,
  type Classification,
} from "./classifier.js";
