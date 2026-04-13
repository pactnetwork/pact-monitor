import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PactMonitor } from "./wrapper.js";
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
    assert.equal(failures[0]!.classification, "error");
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
    assert.equal(failures[0]!.classification, "error");
  });
});
