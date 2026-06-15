// Tests for the pay.sh integration layer used by `pact pay`:
// resolvePayActiveAccount (YAML reader), exportPayKeypair (shell wrapper around
// `pay account export <name> -`), and loadUnifiedWallet (env-or-pay resolver).
// The pay binary is never touched — payShell is injected, and a temp
// accounts.yml on disk is used for the YAML-reader cases.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import yaml from "js-yaml";

import {
  resolvePayActiveAccount,
  exportPayKeypair,
  loadUnifiedWallet,
} from "../src/lib/pay-wallet.ts";

function encodeKeypairJson(kp: Keypair): string {
  return JSON.stringify(Array.from(kp.secretKey));
}

function makeShellResult(opts: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}) {
  return {
    exitCode: opts.exitCode ?? 0,
    stdout: new TextEncoder().encode(opts.stdout ?? ""),
    stderr: new TextEncoder().encode(opts.stderr ?? ""),
  };
}

function writeTempAccountsYml(contents: string | object): {
  dir: string;
  path: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "pact-pay-wallet-test-"));
  const path = join(dir, "accounts.yml");
  const body = typeof contents === "string" ? contents : yaml.dump(contents);
  writeFileSync(path, body, "utf8");
  return { dir, path };
}

describe("resolvePayActiveAccount", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    while (cleanups.length) {
      const d = cleanups.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  test("returns the active mainnet account when accounts.yml has one", () => {
    const kp = Keypair.generate();
    const { dir, path } = writeTempAccountsYml({
      version: 2,
      accounts: {
        mainnet: {
          "pact-demo": {
            keystore: "file",
            active: true,
            auth_required: false,
            pubkey: kp.publicKey.toBase58(),
          },
        },
      },
    });
    cleanups.push(dir);

    const acc = resolvePayActiveAccount({ cluster: "mainnet", accountsPath: path });
    expect(acc).not.toBeNull();
    expect(acc!.name).toBe("pact-demo");
    expect(acc!.cluster).toBe("mainnet");
    expect(acc!.pubkey).toBe(kp.publicKey.toBase58());
    expect(acc!.keystore).toBe("file");
    expect(acc!.authRequired).toBe(false);
  });

  test("returns null when accounts.yml doesn't exist", () => {
    const missing = join(tmpdir(), "pact-pay-wallet-does-not-exist-" + Date.now() + ".yml");
    const acc = resolvePayActiveAccount({ cluster: "mainnet", accountsPath: missing });
    expect(acc).toBeNull();
  });

  test("returns null when the file exists but YAML is malformed", () => {
    const { dir, path } = writeTempAccountsYml(":\n  - this is\n :::not valid: yaml: [");
    cleanups.push(dir);
    const acc = resolvePayActiveAccount({ cluster: "mainnet", accountsPath: path });
    expect(acc).toBeNull();
  });

  test("returns null when no account on the given cluster has active:true", () => {
    const kp = Keypair.generate();
    const { dir, path } = writeTempAccountsYml({
      version: 2,
      accounts: {
        mainnet: {
          "inactive-one": {
            keystore: "file",
            active: false,
            pubkey: kp.publicKey.toBase58(),
          },
        },
      },
    });
    cleanups.push(dir);
    const acc = resolvePayActiveAccount({ cluster: "mainnet", accountsPath: path });
    expect(acc).toBeNull();
  });

  test("skips cluster filter when cluster is omitted (finds active across all clusters)", () => {
    const kp = Keypair.generate();
    const { dir, path } = writeTempAccountsYml({
      version: 2,
      accounts: {
        devnet: {
          "devnet-only": {
            keystore: "file",
            active: true,
            pubkey: kp.publicKey.toBase58(),
          },
        },
      },
    });
    cleanups.push(dir);
    const acc = resolvePayActiveAccount({ accountsPath: path });
    expect(acc).not.toBeNull();
    expect(acc!.cluster).toBe("devnet");
    expect(acc!.name).toBe("devnet-only");
  });

  test("honors accountsPath override (does not read real ~/.config/pay/accounts.yml)", () => {
    // Point at a guaranteed-nonexistent path; even if the host has a real
    // accounts.yml, this should resolve to null because we're explicitly
    // overriding the path.
    const fake = join(tmpdir(), "pact-pay-wallet-override-" + Date.now() + ".yml");
    const acc = resolvePayActiveAccount({ cluster: "mainnet", accountsPath: fake });
    expect(acc).toBeNull();
  });
});

describe("exportPayKeypair", () => {
  test("happy path: payShell returns a valid 64-byte JSON array → returns Keypair", async () => {
    const kp = Keypair.generate();
    const stdout = encodeKeypairJson(kp);
    const result = await exportPayKeypair({
      name: "pact-demo",
      payShell: async (args) => {
        expect(args).toEqual(["account", "export", "pact-demo", "-"]);
        return makeShellResult({ exitCode: 0, stdout });
      },
    });
    expect(result.secretKey.length).toBe(64);
    expect(result.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  test("non-zero pay exit code → throws with stderr included in the message", async () => {
    let caught: Error | null = null;
    try {
      await exportPayKeypair({
        name: "pact-demo",
        payShell: async () =>
          makeShellResult({ exitCode: 1, stderr: "auth denied by user" }),
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("exited 1");
    expect(caught!.message).toContain("auth denied by user");
  });

  test("malformed stdout (non-JSON / wrong length) → throws with 'unparseable keypair'", async () => {
    // Wrong-length byte array — passes JSON.parse but fails the 64-byte check.
    let caught: Error | null = null;
    try {
      await exportPayKeypair({
        name: "pact-demo",
        payShell: async () =>
          makeShellResult({ exitCode: 0, stdout: JSON.stringify([1, 2, 3]) }),
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("unparseable keypair");

    // Non-JSON stdout.
    caught = null;
    try {
      await exportPayKeypair({
        name: "pact-demo",
        payShell: async () => makeShellResult({ exitCode: 0, stdout: "not json at all" }),
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("unparseable keypair");
  });
});

describe("loadUnifiedWallet", () => {
  let savedEnv: string | undefined;
  const cleanups: string[] = [];

  beforeEach(() => {
    savedEnv = process.env.PACT_PRIVATE_KEY;
    delete process.env.PACT_PRIVATE_KEY;
  });

  afterEach(() => {
    if (savedEnv !== undefined) process.env.PACT_PRIVATE_KEY = savedEnv;
    else delete process.env.PACT_PRIVATE_KEY;
    while (cleanups.length) {
      const d = cleanups.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  test("PACT_PRIVATE_KEY set → returns env source, skips pay entirely", async () => {
    const kp = Keypair.generate();
    process.env.PACT_PRIVATE_KEY = encodeKeypairJson(kp);

    const result = await loadUnifiedWallet({
      cluster: "mainnet",
      // If pay is invoked, this throws; ensures the env-var path short-circuits.
      payShell: async () => {
        throw new Error("payShell must not be called when PACT_PRIVATE_KEY is set");
      },
    });

    expect(result.source).toBe("env");
    expect(result.payAccount).toBeUndefined();
    expect(result.keypair.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  test("no env, accounts.yml has active account, payShell returns valid keypair → {source:'pay', payAccount}", async () => {
    const kp = Keypair.generate();
    const { dir, path } = writeTempAccountsYml({
      version: 2,
      accounts: {
        mainnet: {
          "pact-demo": {
            keystore: "file",
            active: true,
            auth_required: false,
            pubkey: kp.publicKey.toBase58(),
          },
        },
      },
    });
    cleanups.push(dir);

    const result = await loadUnifiedWallet({
      cluster: "mainnet",
      accountsPath: path,
      payShell: async () => makeShellResult({ exitCode: 0, stdout: encodeKeypairJson(kp) }),
    });

    expect(result.source).toBe("pay");
    expect(result.payAccount).toBeDefined();
    expect(result.payAccount!.name).toBe("pact-demo");
    expect(result.payAccount!.pubkey).toBe(kp.publicKey.toBase58());
    expect(result.keypair.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  test("no env, no accountsPath active account → throws with helpful pay + PACT_PRIVATE_KEY message", async () => {
    const fake = join(tmpdir(), "pact-pay-wallet-loadunified-missing-" + Date.now() + ".yml");
    let caught: Error | null = null;
    try {
      await loadUnifiedWallet({
        cluster: "mainnet",
        accountsPath: fake,
        payShell: async () => makeShellResult({ exitCode: 0, stdout: "" }),
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("pay");
    expect(caught!.message).toContain("PACT_PRIVATE_KEY");
  });

  test("pubkey mismatch: accounts.yml has X but exported keypair derives Y → throws with both values", async () => {
    const yamlKp = Keypair.generate();
    const exportedKp = Keypair.generate();
    const { dir, path } = writeTempAccountsYml({
      version: 2,
      accounts: {
        mainnet: {
          "pact-demo": {
            keystore: "file",
            active: true,
            auth_required: false,
            pubkey: yamlKp.publicKey.toBase58(),
          },
        },
      },
    });
    cleanups.push(dir);

    let caught: Error | null = null;
    try {
      await loadUnifiedWallet({
        cluster: "mainnet",
        accountsPath: path,
        payShell: async () =>
          makeShellResult({ exitCode: 0, stdout: encodeKeypairJson(exportedKp) }),
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain("pubkey mismatch");
    expect(caught!.message).toContain(yamlKp.publicKey.toBase58());
    expect(caught!.message).toContain(exportedKp.publicKey.toBase58());
  });
});
