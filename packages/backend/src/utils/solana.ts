import { Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import bs58 from "bs58";
import { createHash } from "crypto";
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createKeyPairSignerFromBytes,
  address,
  type Address,
  type Rpc,
  type RpcSubscriptions,
  type SolanaRpcApi,
  type SolanaRpcSubscriptionsApi,
  type KeyPairSigner,
} from "@solana/kit";

export interface SolanaConfig {
  rpcUrl: string;
  programId: string;
  oracleKeypairPath?: string;
  oracleKeypairBase58?: string;
  faucetKeypairPath?: string;
  faucetKeypairBase58?: string;
  usdcMint: string;
}

// Module-scope cache so we parse/decode each signer keypair once per process.
// The backend has exactly one identity per role (oracle, faucet), so a simple
// keyed singleton is enough. Tests can wipe a specific role via
// __resetKeypairCacheForTests(role).
const keypairCache = new Map<string, Keypair>();

// Shared base58-or-file loader used by every signer role (oracle, faucet, ...).
// Base58 is checked first because it's the Cloud Run / managed-env form: a
// single string that can live directly in a secret-manager entry or env var,
// so hosted envs never accidentally fall through to a filesystem path they
// don't have.
function loadKeypairFromSources(
  role: string,
  base58: string | undefined,
  path: string | undefined,
): Keypair {
  if (base58) {
    return Keypair.fromSecretKey(bs58.decode(base58));
  }

  if (path) {
    const resolved = path.startsWith("~")
      ? path.replace(/^~/, process.env.HOME ?? "")
      : path;
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf-8"));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every((b) => typeof b === "number" && Number.isInteger(b) && b >= 0 && b <= 255)
    ) {
      throw new Error(
        `Invalid ${role} keypair file at ${resolved}: expected JSON array of 64 bytes (0-255)`,
      );
    }
    return Keypair.fromSecretKey(Uint8Array.from(parsed));
  }

  const upper = role.toUpperCase();
  throw new Error(
    `No ${role} keypair configured: set ${upper}_KEYPAIR_BASE58 (preferred for Cloud Run) or ${upper}_KEYPAIR_PATH`,
  );
}

export function loadOracleKeypair(config: SolanaConfig): Keypair {
  const cached = keypairCache.get("oracle");
  if (cached) return cached;
  const kp = loadKeypairFromSources(
    "oracle",
    config.oracleKeypairBase58,
    config.oracleKeypairPath,
  );
  keypairCache.set("oracle", kp);
  return kp;
}

export function loadFaucetKeypair(config: SolanaConfig): Keypair {
  const cached = keypairCache.get("faucet");
  if (cached) return cached;
  const kp = loadKeypairFromSources(
    "faucet",
    config.faucetKeypairBase58,
    config.faucetKeypairPath,
  );
  keypairCache.set("faucet", kp);
  return kp;
}

// Exposed for tests only.
export function __resetOracleKeypairCacheForTests(): void {
  keypairCache.delete("oracle");
}

export function __resetFaucetKeypairCacheForTests(): void {
  keypairCache.delete("faucet");
}

export interface KitSolanaClient {
  rpc: Rpc<SolanaRpcApi>;
  rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
  oracleSigner: KeyPairSigner;
  programAddress: Address;
  oracleKeypair: Keypair;
}

// Kit-based client for Pinocchio/Codama account reads and instruction sends.
export async function createKitSolanaClient(config: SolanaConfig): Promise<KitSolanaClient> {
  const oracleKeypair = loadOracleKeypair(config);
  const rpcUrl = config.rpcUrl;
  const wsUrl = rpcUrl.replace(/^https?/, (m) => (m === "https" ? "wss" : "ws"));
  const rpc = createSolanaRpc(rpcUrl);
  const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
  const oracleSigner = await createKeyPairSignerFromBytes(oracleKeypair.secretKey);
  return {
    rpc,
    rpcSubscriptions,
    oracleSigner,
    programAddress: address(config.programId),
    oracleKeypair,
  };
}

export function derivePoolPda(programId: PublicKey, hostname: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), Buffer.from(hostname)],
    programId,
  );
}

export function derivePolicyPda(
  programId: PublicKey,
  poolPda: PublicKey,
  agentPubkey: PublicKey,
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("policy"), poolPda.toBuffer(), agentPubkey.toBuffer()],
    programId,
  );
}

// Exposed so tests can lock in the on-chain seed format.
export function callIdSeedBytes(callId: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(callId).digest());
}

export function getSolanaConfig(): SolanaConfig {
  const programId = process.env.SOLANA_PROGRAM_ID;
  if (!programId) {
    throw new Error("SOLANA_PROGRAM_ID env var not set");
  }
  const usdcMint = process.env.USDC_MINT;
  if (!usdcMint) {
    throw new Error("USDC_MINT env var not set");
  }
  return {
    rpcUrl: process.env.SOLANA_RPC_URL ?? "http://127.0.0.1:8899",
    programId,
    oracleKeypairPath: process.env.ORACLE_KEYPAIR_PATH,
    oracleKeypairBase58: process.env.ORACLE_KEYPAIR_BASE58,
    faucetKeypairPath: process.env.FAUCET_KEYPAIR_PATH,
    faucetKeypairBase58: process.env.FAUCET_KEYPAIR_BASE58,
    usdcMint,
  };
}
