import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getAddress, type Hex, type PublicClient } from 'viem';
import {
  PactCoreClient,
  pactCoreAbi,
  encodeCallId,
  slugBytes16,
  decodeContractError,
  SettlementStatus,
  type SettlementRecord,
} from '@pact-network/protocol-zerog-client';
import { ZerogStorageClient } from '@pact-network/zerog-storage-client';
import { SecretLoaderService } from '../config/secret-loader.service';
import { PrismaService } from '../db/prisma.service';
import { BatcherService } from '../batcher/batcher.service';
import { SigningMutex, createClients } from '../chain/chain';
import { buildEvidenceBlob } from '../evidence/evidence';
import type { SettleMessage } from '../consumer/consumer.service';
import type { SettleBatch } from '../batcher/batcher.service';

/** Settler clock can run ahead of 0G `block.timestamp`; subtract a margin so
 *  a fresh event never trips `InvalidTimestamp` (whole-batch revert, T20). */
const TS_SAFETY_MARGIN_S = 5n;
const MAX_DUP_RESLICE = 2;
const ZERO_ROOT = ('0x' + '0'.repeat(64)) as Hex;

export interface SubmitResult {
  toAck: SettleMessage[];
  toNack: SettleMessage[];
  txHash?: Hex;
}

interface Mapped {
  record: SettlementRecord;
  message: SettleMessage;
  blob: Uint8Array;
}

@Injectable()
export class SubmitterService implements OnModuleInit {
  private readonly logger = new Logger(SubmitterService.name);
  private pact!: PactCoreClient;
  private storage!: ZerogStorageClient;
  private publicClient!: PublicClient;
  private account!: `0x${string}`;
  private pactAddress!: Hex;

  constructor(
    private readonly config: ConfigService,
    private readonly secrets: SecretLoaderService,
    private readonly prisma: PrismaService,
    private readonly batcher: BatcherService,
    private readonly mutex: SigningMutex,
  ) {}

  onModuleInit() {
    const chainId = this.config.getOrThrow<number>('ZEROG_CHAIN_ID');
    const rpcUrl = this.config.getOrThrow<string>('ZEROG_RPC_URL');
    this.pactAddress = this.config.getOrThrow<string>('PACT_CORE_ADDRESS') as Hex;
    const indexerUrl = this.config.getOrThrow<string>(
      'ZEROG_STORAGE_INDEXER_URL',
    );

    const account = this.secrets.account;
    this.account = account.address;
    const { publicClient, walletClient, chain } = createClients({
      chainId,
      rpcUrl,
      account,
    });
    this.publicClient = publicClient;
    this.pact = new PactCoreClient({
      address: this.pactAddress,
      publicClient,
      walletClient,
      account,
      chain,
    });
    this.storage = new ZerogStorageClient(
      { chainId, rpcUrl, indexerUrl },
      this.secrets.privateKey,
    );
  }

  /** Map a raw message → SettlementRecord. The batcher already validated the
   *  fields; this only normalizes. Throws only on genuinely corrupt input. */
  private map(message: SettleMessage, blockTs: bigint): Mapped {
    const d = message.data as Record<string, unknown>;
    const callIdStr = String(d['callId']);
    const slugStr = String(d['endpointSlug']);
    const agent = getAddress(String(d['agentPubkey']));
    const outcome = String(d['outcome']);
    const breach = outcome !== 'ok';
    const premiumWei = BigInt((d['premiumLamports'] as string) ?? '0');
    const refundWei = BigInt((d['refundLamports'] as string) ?? '0');
    const eventTs = BigInt(Math.floor(Date.parse(String(d['ts'])) / 1000));
    const ceil = blockTs - TS_SAFETY_MARGIN_S;

    return {
      record: {
        callId: encodeCallId(callIdStr),
        slug: slugBytes16(slugStr),
        agent,
        breach,
        premiumWei,
        refundWei,
        timestamp: eventTs < ceil ? eventTs : ceil,
        rootHash: ZERO_ROOT,
      },
      message,
      blob: buildEvidenceBlob({
        callId: callIdStr,
        agent,
        endpointSlug: slugStr,
        premiumWei,
        refundWei,
        latencyMs: Number(d['latencyMs'] ?? 0),
        outcome: outcome as never,
        breach,
        ts: String(d['ts']),
      }),
    };
  }

  /** Split by on-chain status. Already-settled callIds are dropped from the
   *  batch (ack + LRU) so a redelivered/crash-replayed dup never triggers the
   *  whole-batch `DuplicateCallId` revert (T5). */
  private async partition(
    items: Mapped[],
  ): Promise<{ unsettled: Mapped[]; settled: Mapped[] }> {
    const unsettled: Mapped[] = [];
    const settled: Mapped[] = [];
    for (const it of items) {
      const status = await this.pact.getCallStatus(it.record.callId);
      if (status === SettlementStatus.Unsettled) unsettled.push(it);
      else settled.push(it);
    }
    return { unsettled, settled };
  }

  private ackSettled(settled: Mapped[], toAck: SettleMessage[]): void {
    if (settled.length === 0) return;
    this.batcher.markSettled(settled.map((s) => s.record.callId));
    for (const s of settled) toAck.push(s.message);
  }

  async submit(batch: SettleBatch): Promise<SubmitResult> {
    const toAck: SettleMessage[] = [];
    const toNack: SettleMessage[] = [];

    const blockTs = await this.publicClient
      .getBlock({ blockTag: 'latest' })
      .then((b) => b.timestamp);

    let items: Mapped[] = [];
    for (const m of batch.messages) {
      try {
        items.push(this.map(m, blockTs));
      } catch (e) {
        this.logger.warn(`unmappable message acked+dropped: ${String(e)}`);
        toAck.push(m); // batcher should have caught this; never poison
      }
    }

    let attempt = 0;
    while (attempt <= MAX_DUP_RESLICE) {
      const { unsettled, settled } = await this.partition(items);
      this.ackSettled(settled, toAck);
      if (unsettled.length === 0) return { toAck, toNack };

      const records = unsettled.map((u) => u.record);
      const callIds = unsettled.map((u) => u.record.callId);

      // Pre-flight: simulate decodes the exact revert WITHOUT gas or upload.
      try {
        await this.publicClient.simulateContract({
          address: this.pactAddress,
          abi: pactCoreAbi,
          functionName: 'settleBatch',
          args: [records],
          account: this.account,
        });
      } catch (e) {
        const dec = decodeContractError(e);
        if (dec?.name === 'DuplicateCallId' && attempt < MAX_DUP_RESLICE) {
          this.logger.warn('DuplicateCallId — re-querying status & reslicing');
          items = unsettled;
          attempt++;
          continue;
        }
        // Unrecoverable (ProtocolPaused / Unauthorized / RPC / …). Nothing was
        // uploaded, so no orphan rows to track — just nack for redelivery.
        this.logger.error(
          `settleBatch pre-flight failed: ${dec?.name ?? 'rpc_or_unknown'}`,
        );
        for (const u of unsettled) toNack.push(u.message);
        return { toAck, toNack };
      }

      // Simulate passed → upload evidence (serialized), record orphans, send.
      await this.uploadAndRecord(unsettled);
      try {
        const txHash = await this.mutex.runExclusive(() =>
          this.pact.settleBatch(records),
        );
        const receipt = await this.publicClient.waitForTransactionReceipt({
          hash: txHash,
          confirmations: 1,
        });
        if (receipt.status === 'reverted') {
          await this.prisma.markFailed(callIds, 'reverted_post_simulate');
          for (const u of unsettled) toNack.push(u.message);
          return { toAck, toNack, txHash };
        }
        await this.prisma.markSettled(callIds);
        this.batcher.markSettled(callIds);
        for (const u of unsettled) toAck.push(u.message);
        return { toAck, toNack, txHash };
      } catch (e) {
        await this.prisma.markFailed(callIds, `send_failed:${String(e)}`);
        for (const u of unsettled) toNack.push(u.message);
        return { toAck, toNack };
      }
    }
    for (const it of items) toNack.push(it.message);
    return { toAck, toNack };
  }

  /** Sequential, mutex-serialized uploads (single-EOA nonce safety), then the
   *  orphan rows are written BEFORE the settle tx. */
  private async uploadAndRecord(items: Mapped[]): Promise<void> {
    for (const it of items) {
      const { rootHash } = await this.mutex.runExclusive(() =>
        this.storage.writeEvidence(it.blob),
      );
      it.record.rootHash = rootHash;
    }
    await this.prisma.recordOrphans(
      items.map((i) => ({
        callId: i.record.callId,
        evidenceRootHash: i.record.rootHash,
      })),
    );
  }
}
