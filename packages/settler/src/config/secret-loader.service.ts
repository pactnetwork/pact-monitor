import { Injectable, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

@Injectable()
export class SecretLoaderService implements OnModuleInit {
  private _keypair: Keypair | null = null;
  private readonly client: SecretManagerServiceClient;

  constructor(private readonly config: ConfigService) {
    this.client = new SecretManagerServiceClient();
  }

  async onModuleInit() {
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
