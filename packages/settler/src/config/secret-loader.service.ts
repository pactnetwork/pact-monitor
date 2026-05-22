import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

import { hasSolanaNetwork } from "./enabled-networks";

@Injectable()
export class SecretLoaderService implements OnModuleInit {
  private readonly logger = new Logger(SecretLoaderService.name);
  private _keypair: Keypair | null = null;
  private readonly client: SecretManagerServiceClient;
  private readonly solanaEnabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.client = new SecretManagerServiceClient();
    this.solanaEnabled = hasSolanaNetwork(
      this.config.get<string>("PACT_ENABLED_NETWORKS"),
    );
  }

  async onModuleInit() {
    // The settlement-authority keypair is the Solana settler signer. An
    // EVM-only settler (no solana-* enabled) settles via the per-network EVM
    // signer from AdaptersService (PACT_SETTLER_KEYPAIR_<NETWORK>), so we skip
    // this load entirely and boot without SETTLEMENT_AUTHORITY_KEY (multi-evm
    // WP T5). The `keypair` getter still throws if anything tries to use it.
    if (!this.solanaEnabled) {
      this.logger.log(
        "[settler] EVM-only boot — skipping Solana settlement-authority keypair load",
      );
      return;
    }
    await this.load();
  }

  async load(): Promise<void> {
    const resourcePath = this.config.getOrThrow<string>(
      "SETTLEMENT_AUTHORITY_KEY"
    );

    // If value doesn't look like a Secret Manager resource path, treat it as
    // a raw base58 key. Enables local dev and test usage.
    if (!resourcePath.startsWith("projects/")) {
      const bytes = bs58.decode(resourcePath);
      this._keypair = Keypair.fromSecretKey(bytes);
      return;
    }

    const [version] = await this.client.accessSecretVersion({
      name: resourcePath,
    });
    const raw = version.payload?.data;
    if (!raw) throw new Error("Empty secret payload");
    const keyStr = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
    const bytes = bs58.decode(keyStr.trim());
    this._keypair = Keypair.fromSecretKey(bytes);
  }

  get keypair(): Keypair {
    if (!this._keypair) throw new Error("Keypair not loaded");
    return this._keypair;
  }
}
