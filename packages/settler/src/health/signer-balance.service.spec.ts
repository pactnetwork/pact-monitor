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
import type { AdaptersService } from "../adapters/adapters.service";

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

interface FakeNetwork {
  network: string;
  vm: "evm" | "solana";
  /** Omit to simulate a read-only deploy (getEvmAccount throws). */
  signer?: { address: string };
  balanceWei?: bigint;
  balanceError?: Error;
}

/** Stub AdaptersService for the EVM gas-balance checks. */
function makeAdapters(networks: FakeNetwork[] = []): AdaptersService {
  return {
    listEnabledNetworks: () => networks.map((n) => n.network),
    getAdapter: (network: string) => {
      const n = networks.find((x) => x.network === network);
      if (!n) throw new Error(`no adapter for ${network}`);
      return {
        descriptor: { vm: n.vm },
        getNativeBalance:
          n.vm === "evm"
            ? vi.fn(async () => {
                if (n.balanceError) throw n.balanceError;
                return n.balanceWei ?? 0n;
              })
            : undefined,
      };
    },
    getEvmAccount: (network: string) => {
      const n = networks.find((x) => x.network === network);
      if (!n || !n.signer) throw new Error(`no EVM signer for ${network}`);
      return n.signer;
    },
  } as unknown as AdaptersService;
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

    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp), makeAdapters([]));
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

    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp), makeAdapters([]));
    await svc.poll();

    expect(svc.isLow).toBe(true);
    expect(svc.isCritical).toBe(false);
  });

  it("flags isCritical for balance below CRIT", async () => {
    const kp = Keypair.generate();
    getBalanceMock.mockResolvedValue(CRIT_THRESHOLD_LAMPORTS - 1);

    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp), makeAdapters([]));
    await svc.poll();

    expect(svc.isCritical).toBe(true);
    expect(svc.isLow).toBe(true);
  });

  it("keeps last balance and records lastError on RPC failure", async () => {
    const kp = Keypair.generate();
    getBalanceMock.mockResolvedValueOnce(50_000_000);
    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp), makeAdapters([]));
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
    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp), makeAdapters([]));
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
    const svc = new SignerBalanceService(makeConfig(), failingSecrets, makeAdapters([]));
    await svc.poll();

    expect(svc.currentLamports).toBe(UNKNOWN_BALANCE);
    expect(getBalanceMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// EVM signer gas-balance monitoring (multi-evm WP T4). In addition to the
// Solana check (unchanged), poll the native gas-token balance of each ENABLED
// EVM signer per network and flag below the WARN/CRIT thresholds (default
// 0.01 / 0.003 native token = 1e16 / 3e15 wei; chain-scoped env override).
// ---------------------------------------------------------------------------

describe("SignerBalanceService — EVM signer gas-balance (multi-evm WP T4)", () => {
  beforeEach(() => {
    getBalanceMock.mockReset();
    register.clear();
  });

  it("checks each enabled EVM signer's native balance and records status by threshold", async () => {
    const kp = Keypair.generate();
    getBalanceMock.mockResolvedValue(50_000_000);
    const adapters = makeAdapters([
      // 0.02 native > WARN(0.01) -> ok
      { network: "arc-testnet", vm: "evm", signer: { address: "0xArc" }, balanceWei: 20_000_000_000_000_000n },
      // 0.001 native < CRIT(0.003) -> crit
      { network: "evm-test-2", vm: "evm", signer: { address: "0xB" }, balanceWei: 1_000_000_000_000_000n },
      { network: "solana-devnet", vm: "solana" },
    ]);

    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp), adapters);
    await svc.poll();

    expect(svc.getEvmSignerState("arc-testnet")?.status).toBe("ok");
    expect(svc.getEvmSignerState("arc-testnet")?.wei).toBe(20_000_000_000_000_000n);
    expect(svc.getEvmSignerState("evm-test-2")?.status).toBe("crit");
    // Solana network is not tracked as an EVM signer.
    expect(svc.getEvmSignerState("solana-devnet")).toBeUndefined();
  });

  it("flags 'warn' between CRIT and WARN", async () => {
    const kp = Keypair.generate();
    getBalanceMock.mockResolvedValue(50_000_000);
    // 0.005 native: < WARN(0.01), > CRIT(0.003) -> warn
    const adapters = makeAdapters([
      { network: "arc-testnet", vm: "evm", signer: { address: "0xArc" }, balanceWei: 5_000_000_000_000_000n },
    ]);
    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp), adapters);
    await svc.poll();
    expect(svc.getEvmSignerState("arc-testnet")?.status).toBe("warn");
  });

  it("still runs the Solana balance check unchanged", async () => {
    const kp = Keypair.generate();
    getBalanceMock.mockResolvedValue(50_000_000);
    const adapters = makeAdapters([
      { network: "arc-testnet", vm: "evm", signer: { address: "0xArc" }, balanceWei: 20_000_000_000_000_000n },
    ]);
    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp), adapters);
    await svc.poll();

    expect(getBalanceMock).toHaveBeenCalledWith(kp.publicKey, "confirmed");
    expect(svc.currentLamports).toBe(50_000_000);
  });

  it("skips an EVM network with no loaded signer (read-only) without throwing", async () => {
    const kp = Keypair.generate();
    getBalanceMock.mockResolvedValue(50_000_000);
    const adapters = makeAdapters([
      { network: "arc-testnet", vm: "evm", balanceWei: 1n }, // no signer
    ]);
    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp), adapters);

    await expect(svc.poll()).resolves.toBeUndefined();
    expect(svc.getEvmSignerState("arc-testnet")).toBeUndefined();
  });

  it("honors a chain-scoped gas threshold env override", async () => {
    const kp = Keypair.generate();
    getBalanceMock.mockResolvedValue(50_000_000);
    // WARN override = 0.05 native; arc balance 0.02 -> below WARN, above CRIT -> warn.
    const config = {
      get: vi.fn((k: string) =>
        k === "PACT_EVM_GAS_WARN_WEI_ARC_TESTNET"
          ? "50000000000000000"
          : undefined,
      ),
      getOrThrow: vi.fn((k: string) => {
        if (k === "SOLANA_RPC_URL") return "https://api.mainnet-beta.solana.com";
        throw new Error(`unexpected key ${k}`);
      }),
    } as unknown as ConfigService;
    const adapters = makeAdapters([
      { network: "arc-testnet", vm: "evm", signer: { address: "0xArc" }, balanceWei: 20_000_000_000_000_000n },
    ]);
    const svc = new SignerBalanceService(config, makeSecrets(kp), adapters);
    await svc.poll();

    expect(svc.getEvmSignerState("arc-testnet")?.status).toBe("warn");
  });

  it("does not let an EVM balance RPC failure throw out of poll()", async () => {
    const kp = Keypair.generate();
    getBalanceMock.mockResolvedValue(50_000_000);
    const adapters = makeAdapters([
      {
        network: "arc-testnet",
        vm: "evm",
        signer: { address: "0xArc" },
        balanceError: new Error("evm rpc down"),
      },
    ]);
    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp), adapters);

    await expect(svc.poll()).resolves.toBeUndefined();
    // Solana check still succeeded despite the EVM RPC failure.
    expect(svc.currentLamports).toBe(50_000_000);
    expect(svc.getEvmSignerState("arc-testnet")).toBeUndefined();
  });

  // EVM-only boot (multi-evm WP T5 redo): no solana-* enabled, no SOLANA_RPC_URL.
  // The constructor must NOT getOrThrow SOLANA_RPC_URL or build a Connection,
  // and pollSolana must be skipped while pollEvmSigners still runs.
  it("constructs EVM-only without SOLANA_RPC_URL and skips the Solana poll", async () => {
    const env: Record<string, string | undefined> = {
      PACT_ENABLED_NETWORKS: "arc-testnet",
    };
    const config = {
      get: vi.fn((k: string) => env[k]),
      getOrThrow: vi.fn((k: string) => {
        throw new Error(`missing ${k}`);
      }),
    } as unknown as ConfigService;
    const kp = Keypair.generate();
    const adapters = makeAdapters([
      { network: "arc-testnet", vm: "evm", signer: { address: "0xArc" }, balanceWei: 20_000_000_000_000_000n },
    ]);

    const svc = new SignerBalanceService(config, makeSecrets(kp), adapters);
    expect(svc.solanaMonitored).toBe(false);
    expect(config.getOrThrow).not.toHaveBeenCalledWith("SOLANA_RPC_URL");

    await expect(svc.poll()).resolves.toBeUndefined();
    // Solana poll skipped — never queried the Solana balance.
    expect(getBalanceMock).not.toHaveBeenCalled();
    expect(svc.currentLamports).toBe(UNKNOWN_BALANCE);
    // EVM signer still monitored.
    expect(svc.getEvmSignerState("arc-testnet")?.status).toBe("ok");
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
    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp), makeAdapters([]));
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
    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp), makeAdapters([]));
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
    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp), makeAdapters([]));
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
    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp), makeAdapters([]));
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
    const svc = new SignerBalanceService(makeConfig(), makeSecrets(kp), makeAdapters([]));
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
