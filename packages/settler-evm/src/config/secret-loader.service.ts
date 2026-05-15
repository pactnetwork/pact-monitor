import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

/**
 * Loads the single settlement-authority EOA key. The SAME key signs both the
 * viem `settleBatch` tx and the ethers-based 0G Storage upload — see the
 * single-EOA nonce-safety note in the submitter. `SETTLEMENT_AUTHORITY_KEY` is
 * either a Secret Manager resource path ("projects/...") resolving to a 0x
 * private key, or a raw 0x private key (local dev / tests).
 */
@Injectable()
export class SecretLoaderService implements OnModuleInit {
  private _account: PrivateKeyAccount | null = null;
  private _privateKey: `0x${string}` | null = null;
  private readonly client: SecretManagerServiceClient;

  constructor(private readonly config: ConfigService) {
    this.client = new SecretManagerServiceClient();
  }

  async onModuleInit() {
    await this.load();
  }

  async load(): Promise<void> {
    const ref = this.config.getOrThrow<string>('SETTLEMENT_AUTHORITY_KEY');

    let hex: string;
    if (!ref.startsWith('projects/')) {
      hex = ref.trim();
    } else {
      const [version] = await this.client.accessSecretVersion({ name: ref });
      const raw = version.payload?.data;
      if (!raw) throw new Error('Empty secret payload');
      hex = (typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')).trim();
    }

    const normalized = (hex.startsWith('0x') ? hex : `0x${hex}`) as `0x${string}`;
    // Throws on a malformed key — fail loud at boot, never at first settle.
    this._account = privateKeyToAccount(normalized);
    this._privateKey = normalized;
  }

  get account(): PrivateKeyAccount {
    if (!this._account) throw new Error('Settlement key not loaded');
    return this._account;
  }

  /** Raw 0x key — fed to the ethers-based ZerogStorageClient. */
  get privateKey(): `0x${string}` {
    if (!this._privateKey) throw new Error('Settlement key not loaded');
    return this._privateKey;
  }
}
