import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  ChainAdapter,
  EvmAdapter,
  SolanaAdapter,
  getChain,
  listChains,
} from "@pact-network/shared";
import { resolveDeployment } from "@pact-network/protocol-evm-v1-client";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Hex } from "viem";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

// The deployed Solana program. Mirrors SubmitterService.DEFAULT_PROGRAM_ID so
// the adapter settle path derives PDAs under the same program the legacy
// submitter path uses; both read the PROGRAM_ID env first.
const DEFAULT_PROGRAM_ID = "5jBQb7fLz8FNSsHcc9qLzULDRNL5MkHbjjXMqZodwrU5";

@Injectable()
export class AdaptersService implements OnModuleInit {
  private readonly logger = new Logger(AdaptersService.name);
  private readonly adapters = new Map<string, ChainAdapter>();
  private readonly keypairs = new Map<string, Keypair>();
  private readonly evmAccounts = new Map<string, PrivateKeyAccount>();
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
        // FS7: without an explicit programId the SolanaAdapter falls back to the
        // client's mainnet PROGRAM_ID constant and derives endpoint/pool PDAs
        // under the wrong program, so devnet settle_batch can never find the
        // on-chain accounts. Read PROGRAM_ID the same way the legacy submitter
        // does so both paths target the deployed program.
        const programId = new PublicKey(
          this.config.get<string>("PROGRAM_ID") ?? DEFAULT_PROGRAM_ID,
        );
        const adapter = new SolanaAdapter({ descriptor, rpcUrl, programId });
        this.adapters.set(name, adapter);

        // Load signer (per-network env or shared PACT_SETTLER_KEYPAIR fallback)
        const kp = this.loadKeypair(name);
        if (kp) this.keypairs.set(name, kp);
      } else if (descriptor.vm === "evm") {
        if (!descriptor.chainId) {
          throw new Error(`evm network ${name} missing chainId`);
        }
        if (!descriptor.rpcUrl) {
          throw new Error(`evm network ${name} missing rpcUrl`);
        }
        if (descriptor.finalityBlocks == null) {
          throw new Error(`evm network ${name} missing finalityBlocks`);
        }
        if (descriptor.blockTimeMs == null) {
          throw new Error(`evm network ${name} missing blockTimeMs`);
        }
        if (descriptor.deploymentBlock == null) {
          throw new Error(`evm network ${name} missing deploymentBlock`);
        }

        const account = this.loadEvmAccount(name);
        // NOTE: passing process.env bypasses Nest ConfigService. Acceptable for
        // Phase 1 (ConfigService backs onto process.env). Phase 2 (Rick
        // follow-up post WP-MN-04 Gate B) must switch to per-key
        // this.config.get(...) calls for proper config provider abstraction.
        // See WP-MN-04 T4 code-review Important #1.
        const deployment = resolveDeployment(
          descriptor.chainId,
          name,
          process.env,
        );

        const adapter = new EvmAdapter({
          descriptor,
          rpcUrl: descriptor.rpcUrl,
          finalityBlocks: descriptor.finalityBlocks,
          blockTimeMs: descriptor.blockTimeMs,
          deploymentBlock: BigInt(descriptor.deploymentBlock),
          deployment,
          ...(account ? { signer: { account } } : {}),
        });
        this.adapters.set(name, adapter);
        if (account) this.evmAccounts.set(name, account);
      }
    }

    this.logger.log(
      `[settler] adapters bootstrapped: ${enabled.join(", ")} | legacyDirectSolana=${this.legacyDirectSolana}`,
    );

    // Orphan-signer guard (smoke F3 / feedback_di_boot_test.md).
    // A PACT_SETTLER_KEYPAIR_<NETWORK> env set for a network NOT in
    // PACT_ENABLED_NETWORKS is almost always a silent-degradation bug:
    // operator wired the signer but forgot to enable the network, so the
    // settler boots without the adapter and nothing surfaces the mismatch
    // until a settlement event for that network arrives. The smoke caught
    // this exact shape — settler .env had PACT_SETTLER_KEYPAIR_{ARC,BASE}
    // but no PACT_ENABLED_NETWORKS, so only solana-devnet booted. Warn
    // loudly per orphan so the misconfiguration is caught at boot.
    const enabledSet = new Set(enabled);
    const orphans: string[] = [];
    for (const chain of listChains()) {
      if (enabledSet.has(chain.network)) continue;
      const envKey = `PACT_SETTLER_KEYPAIR_${chain.network.replace(/-/g, "_").toUpperCase()}`;
      if (this.config.get<string>(envKey)) {
        orphans.push(`${envKey} (network "${chain.network}")`);
      }
    }
    if (orphans.length > 0) {
      this.logger.warn(
        `[settler] orphan signer env(s) detected — keypair set but network not in ` +
          `PACT_ENABLED_NETWORKS, so the adapter will NOT boot and any settlement ` +
          `event for these networks will fail at submit. Either add the network to ` +
          `PACT_ENABLED_NETWORKS or unset the env. Orphans: ${orphans.join(", ")}`,
      );
    }
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

  getEvmAccount(network: string): PrivateKeyAccount {
    const account = this.evmAccounts.get(network);
    if (!account) {
      throw new Error(`No EVM signer loaded for network "${network}"`);
    }
    return account;
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
    if (raw) {
      try {
        return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
      } catch (e) {
        this.logger.warn(`Failed to parse keypair for ${network}: ${e}`);
        return null;
      }
    }
    // FS6: share the Solana signer source with the legacy submitter path.
    // Deployments commonly set only SETTLEMENT_AUTHORITY_KEY (the settlement
    // authority IS the settle_batch signer); without this fallback the adapter
    // settle path boots with no Solana signer while /health still reports one
    // from the legacy SecretLoaderService. Mirror that service's raw-base58
    // decode. The Secret Manager ("projects/…") form needs async access and
    // stays on the legacy loader — adapter SM support is a follow-up.
    if (network.startsWith("solana-")) {
      const sa = this.config.get<string>("SETTLEMENT_AUTHORITY_KEY")?.trim();
      if (sa && !sa.startsWith("projects/")) {
        try {
          return Keypair.fromSecretKey(bs58.decode(sa));
        } catch (e) {
          this.logger.warn(
            `Failed to parse SETTLEMENT_AUTHORITY_KEY fallback for ${network}: ${e}`,
          );
        }
      }
    }
    return null;
  }

  /**
   * Load an EVM signer for a network. Supports two phases per D6 §6:
   *   Phase 1 (now): raw 0x-hex env value via PACT_SETTLER_KEYPAIR_<NETWORK>
   *   Phase 2 (later): "projects/<gcp>/secrets/.../versions/latest" resource path
   *     (Secret Manager; requires making onModuleInit async — deferred to Phase 2)
   * Returns null when the env is unset (acceptable in test mode or read-only deploys).
   */
  private loadEvmAccount(network: string): PrivateKeyAccount | null {
    const envKey = `PACT_SETTLER_KEYPAIR_${network.replace(/-/g, "_").toUpperCase()}`;
    const raw = this.config.get<string>(envKey);
    if (!raw) return null;

    if (raw.startsWith("projects/")) {
      // Phase 2: Secret Manager resource path — not yet supported in Phase 1.
      // Warn and skip rather than throw, so the service boots without a signer
      // in environments where Secret Manager is not yet wired.
      this.logger.warn(
        `[settler] EVM signer for ${network}: Secret Manager paths (Phase 2) not yet supported — skipping signer load. Set a raw 0x-hex value for Phase 1.`,
      );
      return null;
    }

    try {
      const hex = (
        raw.trim().startsWith("0x") ? raw.trim() : `0x${raw.trim()}`
      ) as Hex;
      return privateKeyToAccount(hex);
    } catch (e) {
      this.logger.warn(`Failed to parse EVM private key for ${network}: ${e}`);
      return null;
    }
  }
}
