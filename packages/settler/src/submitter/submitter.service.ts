import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Connection,
  Transaction,
  sendAndConfirmTransaction,
  PublicKey,
} from "@solana/web3.js";
import {
  buildSettleBatch,
  deriveSettlementAuthority,
  deriveCoveragePool,
  deriveCallRecord,
  deriveAgentWallet,
  slugBytes,
  SettlementEvent,
} from "@pact-network/market-client";
import { SecretLoaderService } from "../config/secret-loader.service";
import { SettleBatch } from "../batcher/batcher.service";

export class BatchSubmitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchSubmitError";
  }
}

@Injectable()
export class SubmitterService {
  private readonly logger = new Logger(SubmitterService.name);
  private readonly connection: Connection;
  private readonly programId: PublicKey;

  constructor(
    private readonly config: ConfigService,
    private readonly secrets: SecretLoaderService
  ) {
    const rpc = this.config.getOrThrow<string>("SOLANA_RPC_URL");
    this.connection = new Connection(rpc, "confirmed");
    this.programId = new PublicKey(
      this.config.get<string>("PROGRAM_ID") ??
        "DhWibM2z3Vwp5VmJyashoeZCAZHLFKeHab8o12qYsiQc"
    );
  }

  async submit(batch: SettleBatch): Promise<string> {
    const keypair = this.secrets.keypair;
    const settler = keypair.publicKey;

    const [settlementAuthPda] = deriveSettlementAuthority();
    const [poolPda] = deriveCoveragePool();

    const events: SettlementEvent[] = batch.messages.map((m) => {
      const d = m.data as Record<string, unknown>;
      const slug = slugBytes(d["endpointSlug"] as string);
      const agentOwner = new PublicKey(d["agentPubkey"] as string);
      const [agentWalletPda] = deriveAgentWallet(agentOwner);

      const callIdHex = (d["callId"] as string).replace(/-/g, "");
      const callId = Buffer.from(callIdHex, "hex");

      return {
        callId,
        agentOwner,
        agentWalletPda,
        agentVault: new PublicKey(d["agentVault"] as string),
        endpointPda: new PublicKey(d["endpointPda"] as string),
        slug,
        premiumLamports: BigInt(d["premiumLamports"] as string),
        refundLamports: BigInt(d["refundLamports"] as string),
        latencyMs: d["latencyMs"] as number,
        breach: d["breach"] as boolean,
        timestamp: d["timestamp"] as number,
      };
    });

    const callRecordPdas = events.map((e) => deriveCallRecord(e.callId)[0]);

    // USDC vault on pool — read from pool account or pass as known PDA
    const poolVault = new PublicKey(
      this.config.get<string>("POOL_VAULT_PUBKEY") ??
        PublicKey.default.toBase58()
    );

    const ix = buildSettleBatch(
      settler,
      settlementAuthPda,
      poolPda,
      poolVault,
      events,
      callRecordPdas
    );

    const lastError = await this.sendWithRetry(async () => {
      const tx = new Transaction().add(ix);
      return sendAndConfirmTransaction(this.connection, tx, [keypair], {
        commitment: "confirmed",
      });
    }, 3);

    if (typeof lastError === "string") {
      return lastError;
    }
    throw lastError;
  }

  private async sendWithRetry(
    fn: () => Promise<string>,
    maxAttempts: number
  ): Promise<string | BatchSubmitError> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        this.logger.warn(`submit attempt ${attempt}/${maxAttempts} failed: ${err}`);
        if (attempt < maxAttempts) {
          await sleep(500 * 2 ** (attempt - 1));
        }
      }
    }
    return new BatchSubmitError(
      `All ${maxAttempts} submit attempts failed: ${lastErr}`
    );
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
