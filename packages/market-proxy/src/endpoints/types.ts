import type { EndpointRow } from "../lib/endpoints.js";

export type Outcome = "ok" | "client_error" | "server_error" | "timeout";

export interface ClassifyResult {
  outcome: Outcome;
  premium: bigint;
  refund: bigint;
  breach: boolean;
  reason?: "latency" | "5xx" | "network";
}

export interface EndpointHandler {
  buildRequest(req: Request, upstreamBase: string): Promise<Request>;
  classify(resp: Response, latencyMs: number, endpoint: EndpointRow): Promise<ClassifyResult>;
  isInsurableMethod(req: Request): Promise<boolean>;
}
