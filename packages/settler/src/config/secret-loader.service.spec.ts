import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import { SecretLoaderService } from "./secret-loader.service";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

vi.mock("@google-cloud/secret-manager", () => ({
  SecretManagerServiceClient: vi.fn().mockImplementation(() => ({
    accessSecretVersion: vi.fn(),
  })),
}));

function makeConfig(
  key: string,
  getValues: Record<string, string | undefined> = {},
): ConfigService {
  return {
    getOrThrow: vi.fn().mockReturnValue(key),
    get: vi.fn((k: string) => getValues[k]),
  } as unknown as ConfigService;
}

describe("SecretLoaderService", () => {
  it("loads keypair from raw base58 key", async () => {
    const devKeypair = Keypair.generate();
    const encoded = bs58.encode(devKeypair.secretKey);
    const svc = new SecretLoaderService(makeConfig(encoded));
    await svc.load();
    expect(svc.keypair.publicKey.toBase58()).toBe(devKeypair.publicKey.toBase58());
  });

  it("throws when key is invalid base58", async () => {
    const svc = new SecretLoaderService(makeConfig("not!!valid!!base58"));
    await expect(svc.load()).rejects.toThrow();
  });

  it("throws accessing keypair before load", () => {
    const devKeypair = Keypair.generate();
    const svc = new SecretLoaderService(makeConfig(bs58.encode(devKeypair.secretKey)));
    expect(() => svc.keypair).toThrow("Keypair not loaded");
  });

  // EVM-only boot (multi-evm WP T5 redo): no solana-* enabled. onModuleInit must
  // NOT load the Solana settlement-authority keypair (no getOrThrow
  // SETTLEMENT_AUTHORITY_KEY); the keypair getter still throws if accessed.
  it("skips the Solana keypair load on an EVM-only deploy (no solana-* enabled)", async () => {
    const config = {
      // getOrThrow throws for everything — proving load() is never reached.
      getOrThrow: vi.fn((k: string) => {
        throw new Error(`missing ${k}`);
      }),
      get: vi.fn((k: string) =>
        k === "PACT_ENABLED_NETWORKS" ? "arc-testnet" : undefined,
      ),
    } as unknown as ConfigService;

    const svc = new SecretLoaderService(config);
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(config.getOrThrow).not.toHaveBeenCalledWith("SETTLEMENT_AUTHORITY_KEY");
    expect(() => svc.keypair).toThrow("Keypair not loaded");
  });

  it("loads the Solana keypair on boot when a Solana network is enabled", async () => {
    const devKeypair = Keypair.generate();
    const encoded = bs58.encode(devKeypair.secretKey);
    const svc = new SecretLoaderService(
      makeConfig(encoded, { PACT_ENABLED_NETWORKS: "solana-devnet" }),
    );
    await svc.onModuleInit();
    expect(svc.keypair.publicKey.toBase58()).toBe(
      devKeypair.publicKey.toBase58(),
    );
  });

  it("fetches from Secret Manager when path starts with projects/", async () => {
    const { SecretManagerServiceClient } = await import("@google-cloud/secret-manager");
    const devKeypair = Keypair.generate();
    const encoded = bs58.encode(devKeypair.secretKey);

    const mockAccess = vi.fn().mockResolvedValue([
      { payload: { data: Buffer.from(encoded) } },
    ]);
    (SecretManagerServiceClient as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      accessSecretVersion: mockAccess,
    }));

    const svc = new SecretLoaderService(
      makeConfig("projects/my-project/secrets/my-secret/versions/latest")
    );
    await svc.load();
    expect(svc.keypair.publicKey.toBase58()).toBe(devKeypair.publicKey.toBase58());
    expect(mockAccess).toHaveBeenCalledOnce();
  });
});
