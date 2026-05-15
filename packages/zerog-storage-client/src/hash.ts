import { MemData } from '@0gfoundation/0g-storage-ts-sdk';

/**
 * Compute the deterministic 0G Storage root hash for a blob WITHOUT uploading.
 * Useful for:
 *   - Idempotency keys in the settler's orphan-blob tracker
 *   - Pre-flight checks (e.g. "have I already uploaded this exact evidence?")
 *
 * Spike 3 confirmed determinism: same bytes → same rootHash across calls.
 */
export async function computeRootHash(blob: Uint8Array): Promise<`0x${string}`> {
  const mem = new MemData(blob);
  const [tree, err] = await mem.merkleTree();
  if (err !== null) throw new Error(`merkleTree error: ${err}`);
  return tree.rootHash() as `0x${string}`;
}
