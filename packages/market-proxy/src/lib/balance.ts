import { LRUCache } from "lru-cache";

export interface BalanceEntry {
  balance: bigint;
  expires: number;
}

export interface RpcClient {
  getAccountInfo(pubkey: string): Promise<{ data: Buffer | Uint8Array } | null>;
}

const TTL_MS = 30_000;

export class BalanceCache {
  private cache: LRUCache<string, BalanceEntry>;

  constructor(
    private readonly rpc: RpcClient,
    maxSize = 1000
  ) {
    this.cache = new LRUCache({ max: maxSize });
  }

  get size(): number {
    return this.cache.size;
  }

  async get(walletPubkey: string): Promise<bigint> {
    const cached = this.cache.get(walletPubkey);
    if (cached && Date.now() < cached.expires) {
      return cached.balance;
    }
    return this.fetch(walletPubkey);
  }

  private async fetch(walletPubkey: string): Promise<bigint> {
    try {
      const info = await this.rpc.getAccountInfo(walletPubkey);
      if (!info?.data) {
        this.cache.set(walletPubkey, { balance: 0n, expires: Date.now() + TTL_MS });
        return 0n;
      }
      // AgentWallet layout: discriminator (8 bytes) + owner (32 bytes) + balance (8 bytes u64 LE)
      const buf = Buffer.isBuffer(info.data) ? info.data : Buffer.from(info.data);
      const balance = buf.readBigUInt64LE(40);
      this.cache.set(walletPubkey, { balance, expires: Date.now() + TTL_MS });
      return balance;
    } catch (err) {
      console.error("[balance] rpc error for", walletPubkey, err);
      return 0n;
    }
  }
}
