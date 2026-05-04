import { describe, it, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PactMonitor } from "./wrapper.js";
import { PactSync } from "./sync.js";
import type { CallRecord } from "./types.js";

describe("PactMonitor events", () => {
  let tmpDir: string;
  let storagePath: string;
  let monitor: PactMonitor;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pact-wrapper-"));
    storagePath = join(tmpDir, "calls.jsonl");
    monitor = new PactMonitor({ storagePath, latencyThresholdMs: 5_000 });
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    monitor.shutdown();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits 'failure' when classification is not success", async () => {
    globalThis.fetch = async () =>
      new Response("oops", { status: 500 }) as any;

    const failures: CallRecord[] = [];
    monitor.on("failure", (record) => failures.push(record));

    await monitor.fetch("https://api.example.com/v1/test");

    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.statusCode, 500);
    assert.equal(failures[0]!.classification, "server_error");
  });

  it("emits 'billed' on every call (success and failure)", async () => {
    globalThis.fetch = async () =>
      new Response('{"ok":true}', { status: 200 }) as any;

    const billed: { callCost: number }[] = [];
    monitor.on("billed", (payload) => billed.push(payload));

    await monitor.fetch("https://api.example.com/v1/test");
    await monitor.fetch("https://api.example.com/v1/test");

    assert.equal(billed.length, 2);
    assert.equal(typeof billed[0]!.callCost, "number");
  });

  it("does NOT emit 'failure' on a successful call", async () => {
    globalThis.fetch = async () =>
      new Response('{"ok":true}', { status: 200 }) as any;

    let fired = false;
    monitor.on("failure", () => {
      fired = true;
    });

    await monitor.fetch("https://api.example.com/v1/test");
    assert.equal(fired, false);
  });

  it("pactOptions.provider overrides hostname-based provider id on success", async () => {
    globalThis.fetch = async () =>
      new Response('{"ok":true}', { status: 200 }) as any;

    await monitor.fetch(
      "http://127.0.0.1:3010/_chaos/helius",
      undefined,
      { provider: "demo-helius" },
    );

    const records = monitor.getRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.hostname, "demo-helius");
  });

  it("pactOptions.provider overrides hostname-based provider id on network error", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    await assert.rejects(
      () =>
        monitor.fetch(
          "http://127.0.0.1:3010/_chaos/helius",
          undefined,
          { provider: "demo-helius" },
        ),
      /ECONNREFUSED/,
    );

    const records = monitor.getRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.hostname, "demo-helius");
  });

  it("emits 'failure' on network error and still rethrows", async () => {
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    const failures: CallRecord[] = [];
    monitor.on("failure", (record) => failures.push(record));

    await assert.rejects(
      () => monitor.fetch("https://api.example.com/v1/test"),
      /ECONNREFUSED/,
    );

    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.classification, "server_error");
  });
});

test("sync payload no longer includes agent_pubkey field", async () => {
  const storage = {
    getUnsynced: () => [
      {
        hostname: "x.com",
        endpoint: "/v1",
        timestamp: new Date().toISOString(),
        statusCode: 200,
        latencyMs: 10,
        classification: "success" as const,
        payment: null,
        synced: false,
        agentPubkey: "should-not-be-sent",
      },
    ],
    markSynced: () => {},
  };
  let capturedPayload: unknown;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url: unknown, init: RequestInit | undefined) => {
    capturedPayload = JSON.parse(init!.body as string);
    return new Response("{}", { status: 200 });
  };
  try {
    const sync = new PactSync(storage as never, "http://x", "k", 1, 10, null);
    await sync.flush();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.notEqual(capturedPayload, undefined, "fetch was never called");
  const record = (capturedPayload as { records: Record<string, unknown>[] }).records[0];
  assert.equal("agent_pubkey" in record, false, "agent_pubkey should be excluded from wire payload");
});

describe("PactSync auth error surfacing (PR 5)", () => {
  // Regression: prior versions caught and silently swallowed every non-2xx
  // sync response. A 401 (invalid API key) made the demo print
  // "billed 1.0000 USDC" while ZERO records reached the backend, with no
  // signal to the consumer. The external-agent UX test on develop caught
  // this. The fix surfaces 401/403 via:
  //   - one stderr log line on first auth failure
  //   - an "auth_error" event on the EventEmitter
  //   - a latched isAuthFailed() getter for polled checks
  // and stops the sync loop so it doesn't keep retrying with the bad key.
  let originalFetch: typeof globalThis.fetch;
  let originalErr: typeof console.error;
  let stderrCaptured: string[];
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalErr = console.error;
    stderrCaptured = [];
    console.error = (msg: unknown) => {
      stderrCaptured.push(String(msg));
    };
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.error = originalErr;
  });

  it("emits auth_error on 401 and stops the sync loop", async () => {
    globalThis.fetch = async () =>
      new Response('{"error":"Invalid API key"}', { status: 401 });

    const events = (await import("events")).EventEmitter;
    const emitter = new events();
    const captured: { status: number; body: string }[] = [];
    emitter.on("auth_error", (e) => captured.push(e as never));

    const storage = {
      getUnsynced: () => [
        {
          hostname: "x.com",
          endpoint: "/v1",
          timestamp: new Date().toISOString(),
          statusCode: 200,
          latencyMs: 10,
          classification: "success" as const,
          payment: null,
          synced: false,
        },
      ],
      markSynced: () => {},
    };
    const sync = new PactSync(
      storage as never,
      "http://x",
      "bad-key",
      1,
      10,
      null,
      emitter,
    );
    await sync.flush();

    assert.equal(captured.length, 1, "auth_error event should fire once");
    assert.equal(captured[0]!.status, 401);
    assert.match(captured[0]!.body, /Invalid API key/);
    assert.equal(sync.isAuthFailed(), true, "auth-failed latch should be set");
    assert.ok(
      stderrCaptured.some((m) => m.includes("sync rejected: 401")),
      `expected stderr to include 'sync rejected: 401', got: ${JSON.stringify(stderrCaptured)}`,
    );
  });

  it("emits auth_error exactly once across multiple flushes (no log spam)", async () => {
    globalThis.fetch = async () =>
      new Response("forbidden", { status: 403 });

    const events = (await import("events")).EventEmitter;
    const emitter = new events();
    let count = 0;
    emitter.on("auth_error", () => {
      count += 1;
    });

    const storage = {
      getUnsynced: () => [
        {
          hostname: "x.com",
          endpoint: "/v1",
          timestamp: new Date().toISOString(),
          statusCode: 200,
          latencyMs: 10,
          classification: "success" as const,
          payment: null,
          synced: false,
        },
      ],
      markSynced: () => {},
    };
    const sync = new PactSync(
      storage as never,
      "http://x",
      "bad",
      1,
      10,
      null,
      emitter,
    );
    await sync.flush();
    await sync.flush(); // would fire again under the old behavior
    await sync.flush();

    assert.equal(count, 1, "auth_error must fire only on the first 401/403");
  });

  it("emits sync_error (not auth_error) on a transient 500", async () => {
    globalThis.fetch = async () => new Response("oops", { status: 500 });

    const events = (await import("events")).EventEmitter;
    const emitter = new events();
    const auth: unknown[] = [];
    const transient: unknown[] = [];
    emitter.on("auth_error", (e) => auth.push(e));
    emitter.on("sync_error", (e) => transient.push(e));

    const storage = {
      getUnsynced: () => [
        {
          hostname: "x.com",
          endpoint: "/v1",
          timestamp: new Date().toISOString(),
          statusCode: 200,
          latencyMs: 10,
          classification: "success" as const,
          payment: null,
          synced: false,
        },
      ],
      markSynced: () => {},
    };
    const sync = new PactSync(
      storage as never,
      "http://x",
      "k",
      1,
      10,
      null,
      emitter,
    );
    await sync.flush();

    assert.equal(auth.length, 0, "500 must not be an auth_error");
    assert.equal(transient.length, 1, "500 should surface as sync_error");
    assert.equal(sync.isAuthFailed(), false, "sync should still be retriable");
  });
});

test("PactMonitor warns when syncEnabled+apiKey but agentPubkey is empty", () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => { warnings.push(msg); };
  try {
    try {
      new PactMonitor({
        syncEnabled: true,
        apiKey: "k",
        backendUrl: "http://localhost:0",
      });
    } catch { /* downstream sync init may fail in test env */ }
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    warnings.some((w) => w.includes("agentPubkey missing")),
    `expected warning containing 'agentPubkey missing', got: [${warnings.join(", ")}]`,
  );
});
