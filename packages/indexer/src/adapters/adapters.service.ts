import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ChainAdapter,
  EvmAdapterStub,
  SolanaAdapter,
  getChain,
} from "@pact-network/shared";

@Injectable()
export class AdaptersService implements OnModuleInit {
  private readonly logger = new Logger(AdaptersService.name);
  private readonly adapters = new Map<string, ChainAdapter>();
  readonly legacyDirectSolana: boolean;

  constructor(private readonly config: ConfigService) {
    this.legacyDirectSolana =
      this.config.get<string>("PACT_LEGACY_DIRECT_SOLANA") === "true";
  }

  onModuleInit(): void {
    const enabledRaw =
      this.config.get<string>("PACT_ENABLED_NETWORKS") ?? "solana-devnet";
    const enabled = enabledRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const name of enabled) {
      const descriptor = getChain(name); // throws on unknown

      if (descriptor.vm === "solana") {
        const rpcUrl = this.resolveRpcUrl(name);
        const adapter = new SolanaAdapter({ descriptor, rpcUrl });
        this.adapters.set(name, adapter);
      } else if (descriptor.vm === "evm") {
        this.adapters.set(name, new EvmAdapterStub({ descriptor }));
      }
    }

    this.logger.log(
      `[indexer] adapters bootstrapped: ${enabled.join(", ")} | legacyDirectSolana=${this.legacyDirectSolana}`,
    );
  }

  getAdapter(network: string): ChainAdapter {
    const a = this.adapters.get(network);
    if (!a) {
      throw new Error(
        `No adapter for network "${network}". Enabled: ${[...this.adapters.keys()].join(", ")}`,
      );
    }
    return a;
  }

  listEnabledNetworks(): string[] {
    return [...this.adapters.keys()];
  }

  private resolveRpcUrl(network: string): string {
    const envKey = `PACT_RPC_URL_${network.replace(/-/g, "_").toUpperCase()}`;
    return (
      this.config.get<string>(envKey) ??
      this.config.get<string>("SOLANA_RPC_URL") ??
      "https://api.devnet.solana.com"
    );
  }
}
