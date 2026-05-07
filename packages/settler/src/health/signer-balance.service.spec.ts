import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConfigService } from "@nestjs/config";
import { Keypair } from "@solana/web3.js";
import { register } from "prom-client";

import {
  CRIT_THRESHOLD_LAMPORTS,
  LAMPORTS_PER_SOL,
  SignerBalanceService,
  UNKNOWN_BALANCE,
  WARN_THRESHOLD_LAMPORTS,
} from "./signer-balance.service";
import { HealthController } from "./health.controller";
import { SecretLoaderService } from "../config/secret-loader.service";
import { PipelineService } from "../pipeline/pipeline.service";

// ---------------------------------------------------------------------------
// Mock @solana/web3.js Connection so getBalance is fully controlled.
// We keep PublicKey/Keypair real for derivation parity with the real service.
// ---------------------------------------------------------------------------

const getBalanceMock = vi.fn();

vi.mock("@solana/web3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/web3.js")>();
  return {
    ...actual,
    Connection: vi.fn().mockImplementation(() => ({
      getBalance: getBalanceMock,
    })),
  };
});

function makeConfig(): ConfigService {
  return {
    get: vi.fn(),
    getOrThrow: vi.fn((k: string) => {
      if (k === "SOLANA_RPC_URL") return "https://api.mainnet-beta.solana.com";
      throw new Error(`unexpected key ${k}`);
    }),
  } as unknown as ConfigService;
}

function makeSecrets(kp: Keypair): SecretLoaderService {
  return {
    get keypair() {
      return kp;
    },
  } as unknown as SecretLoaderService;
}

function makePipeline(lagMs: number | null = 0): PipelineService {
  return {
    get lagMs() {
      return lagMs;
    },
  } as unknown as PipelineService;
}

function fakeRes() {
  const res = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
  return res;
}

describe("SignerBalanceService", () => {
  beforeEach(() => {
    getBalanceMock.mockReset();
    register.clear();
  });

  it("polls RPC at boot and exposes balance via gauge + accessor", async () => {
    const kp = Keypair.generate();
    getBalanceMock.mockResolvedValue(50_000_000); // 0.05 SOL

    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp));
    await svc.onModuleInit();

    expect(getBalanceMock).toHaveBeenCalledWith(kp.publicKey, "confirmed");
    expect(svc.currentLamports).toBe(50_000_000);
    expect(svc.lastError).toBeNull();
    expect(svc.lastPolledAt).not.toBeNull();
    expect(svc.isCritical).toBe(false);
    expect(svc.isLow).toBe(false);
  });

  it("flags isLow but not isCritical for balance below WARN but above CRIT", async () => {
    const kp = Keypair.generate();
    getBalanceMock.mockResolvedValue(WARN_THRESHOLD_LAMPORTS - 1);

    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp));
    await svc.poll();

    expect(svc.isLow).toBe(true);
    expect(svc.isCritical).toBe(false);
  });

  it("flags isCritical for balance below CRIT", async () => {
    const kp = Keypair.generate();
    getBalanceMock.mockResolvedValue(CRIT_THRESHOLD_LAMPORTS - 1);

    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp));
    await svc.poll();

    expect(svc.isCritical).toBe(true);
    expect(svc.isLow).toBe(true);
  });

  it("keeps last balance and records lastError on RPC failure", async () => {
    const kp = Keypair.generate();
    getBalanceMock.mockResolvedValueOnce(50_000_000);
    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp));
    await svc.poll();
    expect(svc.currentLamports).toBe(50_000_000);

    getBalanceMock.mockRejectedValueOnce(new Error("rpc 503"));
    await svc.poll();

    expect(svc.currentLamports).toBe(50_000_000); // unchanged
    expect(svc.lastError).toBe("rpc 503");
  });

  it("leaves balance as UNKNOWN if first poll fails", async () => {
    const kp = Keypair.generate();
    getBalanceMock.mockRejectedValueOnce(new Error("rpc unreachable"));
    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp));
    await svc.onModuleInit();

    expect(svc.currentLamports).toBe(UNKNOWN_BALANCE);
    expect(svc.lastError).toBe("rpc unreachable");
  });

  it("does not crash when keypair is not yet loaded", async () => {
    const failingSecrets = {
      get keypair(): Keypair {
        throw new Error("Keypair not loaded");
      },
    } as unknown as SecretLoaderService;
    const svc = new SignerBalanceService(makeConfig(), failingSecrets);
    await svc.poll();

    expect(svc.currentLamports).toBe(UNKNOWN_BALANCE);
    expect(getBalanceMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HealthController — wire-shape contract for Cloud Run / LB consumers.
// ---------------------------------------------------------------------------

describe("HealthController", () => {
  beforeEach(() => {
    register.clear();
  });

  it("returns 200 + status=ok above WARN", async () => {
    const kp = Keypair.generate();
    getBalanceMock.mockResolvedValue(50_000_000);
    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp));
    await svc.poll();

    const ctrl = new HealthController(makePipeline(0), svc);
    const res = fakeRes();
    const body = ctrl.check(res as never);

    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.signer.lamports).toBe(50_000_000);
    expect(body.signer.sol).toBeCloseTo(0.05, 6);
    expect(body.signer.threshold_warn_lamports).toBe(WARN_THRESHOLD_LAMPORTS);
    expect(body.signer.threshold_crit_lamports).toBe(CRIT_THRESHOLD_LAMPORTS);
  });

  it("returns 200 + status=degraded between CRIT and WARN", async () => {
    const kp = Keypair.generate();
    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp));
    svc.setBalanceForTest(WARN_THRESHOLD_LAMPORTS - 1);

    const ctrl = new HealthController(makePipeline(0), svc);
    const res = fakeRes();
    const body = ctrl.check(res as never);

    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.reason).toContain("WARN");
  });

  it("returns 503 + status=unhealthy below CRIT", async () => {
    const kp = Keypair.generate();
    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp));
    svc.setBalanceForTest(CRIT_THRESHOLD_LAMPORTS - 1);

    const ctrl = new HealthController(makePipeline(0), svc);
    const res = fakeRes();
    const body = ctrl.check(res as never);

    expect(res.statusCode).toBe(503);
    expect(body.status).toBe("unhealthy");
    expect(body.reason).toContain("CRIT");
    expect(body.reason).toContain("runbook");
  });

  it("returns 503 when balance has never been polled", async () => {
    const kp = Keypair.generate();
    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp));
    // No setBalanceForTest, no poll() — currentLamports stays UNKNOWN.

    const ctrl = new HealthController(makePipeline(null), svc);
    const res = fakeRes();
    const body = ctrl.check(res as never);

    expect(res.statusCode).toBe(503);
    expect(body.status).toBe("unhealthy");
    expect(body.signer.lamports).toBe(UNKNOWN_BALANCE);
    expect(body.signer.sol).toBe(-1);
  });

  it("uses exact 0.003 SOL boundary correctly (=== CRIT is unhealthy-allowed)", async () => {
    // CRIT is "below 0.003"; exactly 0.003 should NOT be unhealthy.
    const kp = Keypair.generate();
    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp));
    svc.setBalanceForTest(CRIT_THRESHOLD_LAMPORTS); // exactly 3_000_000

    const ctrl = new HealthController(makePipeline(0), svc);
    const res = fakeRes();
    const body = ctrl.check(res as never);

    expect(res.statusCode).toBe(200);
    expect(body.status).toBe("degraded"); // still below WARN, above CRIT
  });

  it("LAMPORTS_PER_SOL constant is 1e9 (sanity)", () => {
    expect(LAMPORTS_PER_SOL).toBe(1_000_000_000);
  });
});
