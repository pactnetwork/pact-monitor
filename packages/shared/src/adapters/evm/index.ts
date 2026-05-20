/**
 * EvmAdapterStub — placeholder ChainAdapter for EVM networks at WP-MN-03b
 * time. Every method throws `Error("EvmAdapter not implemented — WP-MN-04")`.
 * Exists so services can hold an EVM entry in their Map<network, ChainAdapter>
 * without crashing at boot; routes are exercisable; EVM settlement throws
 * loudly until WP-MN-04 lands the real EvmAdapter.
 */

import type {
  ChainAdapter,
  ChainDescriptor,
  EligibilityCheckResult,
  EndpointConfigSnapshot,
  SettleBatchInput,
  SettleBatchResult,
} from "../../chain-adapter";

const NOT_IMPLEMENTED = "EvmAdapter not implemented — WP-MN-04";

export interface EvmAdapterStubOptions {
  descriptor: ChainDescriptor;
}

export class EvmAdapterStub implements ChainAdapter {
  readonly descriptor: ChainDescriptor;

  constructor(opts: EvmAdapterStubOptions) {
    if (opts.descriptor.vm !== "evm") {
      throw new Error(
        `EvmAdapterStub requires descriptor.vm === "evm", got "${opts.descriptor.vm}"`,
      );
    }
    this.descriptor = opts.descriptor;
  }

  async readEndpointConfigs(): Promise<ReadonlyArray<EndpointConfigSnapshot>> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async submitSettleBatch(_: SettleBatchInput): Promise<SettleBatchResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async checkAgentEligibility(
    _: string,
    __: bigint,
  ): Promise<EligibilityCheckResult> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
