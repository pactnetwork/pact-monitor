import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers, type Signer } from 'ethers';
import { Indexer, MemData } from '@0gfoundation/0g-storage-ts-sdk';

export interface StorageNetworkConfig {
  chainId:    number;
  rpcUrl:     string;
  indexerUrl: string;
}

/**
 * The full upload return shape per spike 3 (2026-05-15). Docs and Day-0
 * research said `{ rootHash, txHash }`; reality also includes a numeric
 * `txSeq` field that the indexer assigns. We surface it because the
 * indexer-evm may want to key off it.
 */
export interface WriteEvidenceResult {
  rootHash: `0x${string}`;
  txHash:   `0x${string}`;
  txSeq:    number;
}

/**
 * Pact-0G's Node-only storage helper. Wraps `@0gfoundation/0g-storage-ts-sdk`.
 *
 * Spike 3 (2026-05-15) on Galileo: 334-byte blob, 14.5s upload, 1.5s download,
 * ~61 µ0G flow fee, determinism confirmed. Do NOT import this from the Next.js
 * client bundle — the SDK uses `fs.appendFileSync` on download.
 */
export class ZerogStorageClient {
  private readonly indexer: Indexer;
  private readonly signer:  Signer;

  constructor(
    public readonly network: StorageNetworkConfig,
    privateKey: string,
  ) {
    const provider = new ethers.JsonRpcProvider(network.rpcUrl);
    this.signer    = new ethers.Wallet(privateKey, provider);
    this.indexer   = new Indexer(network.indexerUrl);
  }

  /**
   * Upload a blob and return its rootHash + tx receipt info.
   * Idempotent by content: re-uploading the same bytes returns the same
   * rootHash (the indexer dedupes server-side after the first commit).
   */
  async writeEvidence(blob: Uint8Array): Promise<WriteEvidenceResult> {
    const mem = new MemData(blob);
    const [tx, err] = await this.indexer.upload(mem, this.network.rpcUrl, this.signer);
    if (err !== null) throw new Error(`0G Storage upload failed: ${err}`);
    // The SDK returns `{ rootHash, txHash, txSeq }` — verified in spike 3.
    // Trust the runtime shape; if the SDK changes we'll catch it in CI.
    const result = tx as unknown as WriteEvidenceResult;
    return result;
  }

  /**
   * Fetch a blob by its rootHash and return the raw bytes. Writes to a
   * temp file under the hood because the SDK's download() targets the FS.
   */
  async readEvidence(rootHash: `0x${string}`): Promise<Uint8Array> {
    const dir = mkdtempSync(join(tmpdir(), 'pact-0g-evidence-'));
    const out = join(dir, 'blob.bin');
    try {
      const err = await this.indexer.download(rootHash, out, true);
      if (err !== null) throw new Error(`0G Storage download failed: ${err}`);
      return new Uint8Array(readFileSync(out));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
