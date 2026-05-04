// Insurance-claim-eligible classifications cover provider-side failures only:
// - server_error: 5xx response, network unreachable, DNS failure (provider's fault)
// - timeout: latency exceeded the agent's threshold (provider's fault)
// - schema_mismatch: 2xx body that fails the agent's expected shape (provider returned the wrong thing)
//
// client_error covers 4xx responses including 404, 401, 403, 429. These are
// agent-side issues (wrong URL, missing auth, rate limit) and DO NOT trigger
// claims. Agents should not be insured against asking for the wrong thing.
export type Classification =
  | "success"
  | "timeout"
  | "client_error"
  | "server_error"
  | "schema_mismatch";

export interface PaymentData {
  protocol: "x402" | "mpp";
  amount: number;
  asset: string;
  network: string;
  payerAddress: string;
  recipientAddress: string;
  txHash: string;
  settlementSuccess: boolean;
}

export interface CallRecord {
  hostname: string;
  endpoint: string;
  timestamp: string;
  statusCode: number;
  latencyMs: number;
  classification: Classification;
  payment: PaymentData | null;
  synced: boolean;
}

export interface PactConfig {
  apiKey?: string;
  backendUrl?: string;
  syncEnabled?: boolean;
  syncIntervalMs?: number;
  syncBatchSize?: number;
  latencyThresholdMs?: number;
  storagePath?: string;
  agentPubkey?: string;
  keypair?: { publicKey: Uint8Array; secretKey: Uint8Array };
}

export interface ExpectedSchema {
  type: string;
  required?: string[];
}

export interface FetchOptions extends RequestInit {
  // standard fetch options
}

export interface PactFetchOptions {
  expectedSchema?: ExpectedSchema;
  usdcAmount?: number;
  provider?: string;
}
