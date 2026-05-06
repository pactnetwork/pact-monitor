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

function makeConfig(key: string): ConfigService {
  return { getOrThrow: vi.fn().mockReturnValue(key) } as unknown as ConfigService;
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
