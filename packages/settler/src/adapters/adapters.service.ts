import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ChainAdapter,
  EvmAdapterStub,
  SolanaAdapter,
  getChain,
} from "@pact-network/shared";
import { Keypair } from "@solana/web3.js";

@Injectable()
export class AdaptersService implements OnModuleInit {
  private readonly logger = new Logger(AdaptersService.name);
  private readonly adapters = new Map<string, ChainAdapter>();
  private readonly keypairs = new Map<string, Keypair>();
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

        // Load signer (per-network env or shared PACT_SETTLER_KEYPAIR fallback)
        const kp = this.loadKeypair(name);
        if (kp) this.keypairs.set(name, kp);
      } else if (descriptor.vm === "evm") {
        this.adapters.set(name, new EvmAdapterStub({ descriptor }));
        // EVM signer wiring is WP-MN-04
      }
    }

    this.logger.log(
      `[settler] adapters bootstrapped: ${enabled.join(", ")} | legacyDirectSolana=${this.legacyDirectSolana}`,
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

  getSigner(network: string): Keypair {
    const kp = this.keypairs.get(network);
    if (!kp) {
      throw new Error(`No settler signer loaded for network "${network}"`);
    }
    return kp;
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

  private loadKeypair(network: string): Keypair | null {
    // Per-network env first (PACT_SETTLER_KEYPAIR_<NETWORK>), then fallback
    // to legacy PACT_SETTLER_KEYPAIR for solana-devnet only.
    const perNetwork = this.config.get<string>(
      `PACT_SETTLER_KEYPAIR_${network.replace(/-/g, "_").toUpperCase()}`,
    );
    const fallback =
      network === "solana-devnet"
        ? this.config.get<string>("PACT_SETTLER_KEYPAIR")
        : undefined;
    const raw = perNetwork ?? fallback;
    if (!raw) return null;
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    } catch (e) {
      this.logger.warn(`Failed to parse keypair for ${network}: ${e}`);
      return null;
    }
  }
}
