import { describe, test, afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import {
  shouldTopUpSol,
  __faucetSolPolicyForTests,
} from "../services/faucet.js";

// These tests deliberately skip the live-validator `mint_to` path. Unit scope
// here is:
//   - FAUCET_KEYPAIR_BASE58 / _PATH loader (mirror of the oracle loader tests)
//   - pubkey / amount validation rules
//   - network gate (mainnet + unknown must refuse)
//   - /api/v1/faucet/status payload shape under different network states
// The actual mint_to call is covered by manual testing against devnet on the
// hackathon timeline; a solana-test-validator integration harness is a
// follow-up if the faucet stays in the codebase.

// PR 2: SOL top-up policy. Pure decision tested directly so the on-chain
// drip path doesn't need a live validator to verify the policy is right.
describe("shouldTopUpSol", () => {
  const { thresholdLamports, topUpLamports, minReserveLamports } =
    __faucetSolPolicyForTests;

  it("does not top up when recipient already has SOL above threshold", () => {
    const d = shouldTopUpSol(thresholdLamports, 1 * LAMPORTS_PER_SOL);
    assert.equal(d.topUp, false);
    assert.equal(d.lamports, 0);
    assert.match(d.reason, /already has enough SOL/);
  });

  it("does not top up when recipient is exactly at the threshold (>= rule)", () => {
    const d = shouldTopUpSol(thresholdLamports, 1 * LAMPORTS_PER_SOL);
    assert.equal(d.topUp, false);
  });

  it("does top up when recipient is below threshold and faucet has reserve", () => {
    const d = shouldTopUpSol(0, 1 * LAMPORTS_PER_SOL);
    assert.equal(d.topUp, true);
    assert.equal(d.lamports, topUpLamports);
  });

  it("refuses to top up when faucet reserve would dip below MIN_RESERVE after the transfer", () => {
    // Faucet has just barely enough that one drip would knock it under
    // the floor — the policy must refuse to drain the keypair below the
    // monitoring tripwire.
    const d = shouldTopUpSol(0, minReserveLamports + topUpLamports);
    assert.equal(d.topUp, false);
    assert.equal(d.lamports, 0);
    assert.match(d.reason, /below reserve/);
  });

  it("does top up when faucet has just over MIN_RESERVE + topUp", () => {
    const d = shouldTopUpSol(0, minReserveLamports + topUpLamports + 1);
    assert.equal(d.topUp, true);
    assert.equal(d.lamports, topUpLamports);
  });

  it("constants are sane: threshold < topUp < minReserve", () => {
    // Threshold ~= 0.01 SOL must be smaller than the top-up amount (so
    // one top-up actually moves the recipient above the bar) and the
    // minReserve must be larger than the top-up (so we don't drain on
    // a single drip).
    assert.ok(thresholdLamports < topUpLamports);
    assert.ok(topUpLamports < minReserveLamports);
  });
});

describe("faucet keypair loader", () => {
  afterEach(async () => {
    const { __resetFaucetKeypairCacheForTests } = await import("../utils/solana.js");
    __resetFaucetKeypairCacheForTests();
  });

  test("loads from base58 (Cloud Run form)", async () => {
    const kp = Keypair.generate();
    const base58Secret = bs58.encode(kp.secretKey);

    const { loadFaucetKeypair } = await import("../utils/solana.js");
    const loaded = loadFaucetKeypair({
      rpcUrl: "http://127.0.0.1:8899",
      programId: "11111111111111111111111111111111",
      usdcMint: "11111111111111111111111111111111",
      faucetKeypairBase58: base58Secret,
    });
    assert.equal(loaded.publicKey.toBase58(), kp.publicKey.toBase58());
  });

  test("returns cached instance on subsequent calls", async () => {
    const kp = Keypair.generate();
    const base58Secret = bs58.encode(kp.secretKey);

    const { loadFaucetKeypair, __resetFaucetKeypairCacheForTests } = await import("../utils/solana.js");
    __resetFaucetKeypairCacheForTests();

    const cfg = {
      rpcUrl: "http://127.0.0.1:8899",
      programId: "11111111111111111111111111111111",
      usdcMint: "11111111111111111111111111111111",
      faucetKeypairBase58: base58Secret,
    };

    const a = loadFaucetKeypair(cfg);
    const b = loadFaucetKeypair(cfg);
    assert.strictEqual(a, b, "second call must return the cached keypair instance");
  });

  test("throws when neither base58 nor path is set", async () => {
    const { loadFaucetKeypair, __resetFaucetKeypairCacheForTests } = await import("../utils/solana.js");
    __resetFaucetKeypairCacheForTests();

    assert.throws(
      () =>
        loadFaucetKeypair({
          rpcUrl: "http://127.0.0.1:8899",
          programId: "11111111111111111111111111111111",
          usdcMint: "11111111111111111111111111111111",
        }),
      /FAUCET_KEYPAIR_BASE58.*FAUCET_KEYPAIR_PATH/,
    );
  });
});

describe("faucet validation", () => {
  test("validateRecipient accepts an ed25519 wallet pubkey", async () => {
    const { validateRecipient } = await import("../services/faucet.js");
    const kp = Keypair.generate();
    const pk = validateRecipient(kp.publicKey.toBase58());
    assert.equal(pk.toBase58(), kp.publicKey.toBase58());
  });

  test("validateRecipient rejects empty input", async () => {
    const { validateRecipient, InvalidRecipientError } = await import("../services/faucet.js");
    assert.throws(() => validateRecipient(""), InvalidRecipientError);
  });

  test("validateRecipient rejects gibberish", async () => {
    const { validateRecipient, InvalidRecipientError } = await import("../services/faucet.js");
    assert.throws(() => validateRecipient("not-a-pubkey"), InvalidRecipientError);
  });

  test("validateAmount accepts a whole-USDC integer in range", async () => {
    const { validateAmount } = await import("../services/faucet.js");
    assert.equal(validateAmount(1), 1);
    assert.equal(validateAmount(1_000), 1_000);
    assert.equal(validateAmount(10_000), 10_000);
  });

  test("validateAmount rejects zero, negatives, fractions, oversize", async () => {
    const { validateAmount, AmountOutOfRangeError } = await import("../services/faucet.js");
    assert.throws(() => validateAmount(0), AmountOutOfRangeError);
    assert.throws(() => validateAmount(-5), AmountOutOfRangeError);
    assert.throws(() => validateAmount(1.5), AmountOutOfRangeError);
    assert.throws(() => validateAmount(10_001), AmountOutOfRangeError);
  });

  test("validateAmount rejects non-number input", async () => {
    const { validateAmount, AmountOutOfRangeError } = await import("../services/faucet.js");
    assert.throws(() => validateAmount("1000" as unknown as number), AmountOutOfRangeError);
    assert.throws(() => validateAmount(null as unknown as number), AmountOutOfRangeError);
    assert.throws(() => validateAmount(undefined), AmountOutOfRangeError);
  });
});

describe("faucet network gate", () => {
  afterEach(async () => {
    const { __resetNetworkCacheForTests } = await import("../utils/network.js");
    __resetNetworkCacheForTests();
  });

  test("getFaucetStatus returns enabled:false on mainnet-beta", async () => {
    const { __setNetworkCacheForTests } = await import("../utils/network.js");
    __setNetworkCacheForTests("mainnet-beta");

    // getFaucetStatus reads getSolanaConfig() which requires program id + mint
    // envs; set minimal valid values so the test doesn't explode on missing
    // config before reaching the network check.
    process.env.SOLANA_PROGRAM_ID = "11111111111111111111111111111111";
    process.env.USDC_MINT = "11111111111111111111111111111111";

    const { getFaucetStatus } = await import("../services/faucet.js");
    const status = getFaucetStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.network, "mainnet-beta");
    assert.match(status.reason ?? "", /devnet-only/i);
  });

  test("getFaucetStatus returns enabled:false on unknown network", async () => {
    const { __setNetworkCacheForTests } = await import("../utils/network.js");
    __setNetworkCacheForTests("unknown");

    process.env.SOLANA_PROGRAM_ID = "11111111111111111111111111111111";
    process.env.USDC_MINT = "11111111111111111111111111111111";

    const { getFaucetStatus } = await import("../services/faucet.js");
    const status = getFaucetStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.network, "unknown");
    assert.match(status.reason ?? "", /safety default/i);
  });

  test("getFaucetStatus returns enabled:false on devnet when keypair env is missing", async () => {
    const { __setNetworkCacheForTests } = await import("../utils/network.js");
    __setNetworkCacheForTests("devnet");

    process.env.SOLANA_PROGRAM_ID = "11111111111111111111111111111111";
    process.env.USDC_MINT = "11111111111111111111111111111111";
    delete process.env.FAUCET_KEYPAIR_BASE58;
    delete process.env.FAUCET_KEYPAIR_PATH;

    const { getFaucetStatus } = await import("../services/faucet.js");
    const status = getFaucetStatus();
    assert.equal(status.enabled, false);
    assert.match(status.reason ?? "", /FAUCET_KEYPAIR/);
  });

  test("getFaucetStatus returns enabled:true on devnet with keypair set", async () => {
    const { __setNetworkCacheForTests } = await import("../utils/network.js");
    __setNetworkCacheForTests("devnet");

    process.env.SOLANA_PROGRAM_ID = "11111111111111111111111111111111";
    process.env.USDC_MINT = "11111111111111111111111111111111";
    process.env.FAUCET_KEYPAIR_BASE58 = bs58.encode(Keypair.generate().secretKey);

    const { getFaucetStatus } = await import("../services/faucet.js");
    const status = getFaucetStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.network, "devnet");
    assert.equal(status.maxPerDrip, 10_000);
    assert.equal(status.minPerDrip, 1);

    delete process.env.FAUCET_KEYPAIR_BASE58;
  });

  test("dripUsdc throws FaucetDisabledError on mainnet without touching RPC", async () => {
    const { __setNetworkCacheForTests } = await import("../utils/network.js");
    __setNetworkCacheForTests("mainnet-beta");

    process.env.SOLANA_PROGRAM_ID = "11111111111111111111111111111111";
    process.env.USDC_MINT = "11111111111111111111111111111111";

    const { dripUsdc, FaucetDisabledError } = await import("../services/faucet.js");
    await assert.rejects(
      () =>
        dripUsdc({
          recipient: Keypair.generate().publicKey.toBase58(),
          amount: 100,
        }),
      FaucetDisabledError,
    );
  });

  test("dripUsdc throws FaucetDisabledError when network is unknown", async () => {
    const { __setNetworkCacheForTests } = await import("../utils/network.js");
    __setNetworkCacheForTests("unknown");

    process.env.SOLANA_PROGRAM_ID = "11111111111111111111111111111111";
    process.env.USDC_MINT = "11111111111111111111111111111111";

    const { dripUsdc, FaucetDisabledError } = await import("../services/faucet.js");
    await assert.rejects(
      () =>
        dripUsdc({
          recipient: Keypair.generate().publicKey.toBase58(),
          amount: 100,
        }),
      FaucetDisabledError,
    );
  });
});
