// Exercises the requireBetaKey middleware behind a minimal Hono app.
//
// The gate has two failure-classes worth covering: (1) the flag itself
// (DB row + env fallback when the DB read throws), and (2) the api_keys
// lookup (unknown hash, inactive status, happy path with attached
// betaApplicantId). Both pg + flag are mocked — we do not boot a real
// Postgres for these tests.
//
// Co-located with `test/` to match repo convention (tsconfig.json
// excludes `test/` from the TS build).

import { describe, test, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { createHash } from "node:crypto";

import {
  requireBetaKey,
  BETA_GATE_ERROR,
} from "../src/middleware/require-beta-key.js";
import { createSystemFlagReader } from "../src/lib/system-flag.js";

const SLUG = "helius";

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

interface MakeAppOpts {
  pgQuery: ReturnType<typeof vi.fn>;
  flag: { isBetaGateEnabled: () => Promise<boolean>; bust: () => void };
}

function makeApp(opts: MakeAppOpts) {
  const app = new Hono();
  app.use(
    "/v1/:slug/*",
    requireBetaKey({
      pg: { query: opts.pgQuery } as never,
      flag: opts.flag as never,
    }),
  );
  app.all("/v1/:slug/*", (c) =>
    c.json({
      ok: true,
      betaApplicantId: c.get("betaApplicantId") ?? null,
      apiKeyId: c.get("apiKeyId") ?? null,
    }),
  );
  return app;
}

function flagOff() {
  return {
    isBetaGateEnabled: vi.fn().mockResolvedValue(false),
    bust: vi.fn(),
  };
}

function flagOn() {
  return {
    isBetaGateEnabled: vi.fn().mockResolvedValue(true),
    bust: vi.fn(),
  };
}

describe("requireBetaKey middleware", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("gate off → middleware passes through, no auth check, no DB hit", async () => {
    const pgQuery = vi.fn();
    const flag = flagOff();
    const app = makeApp({ pgQuery, flag });

    const resp = await app.request(`/v1/${SLUG}/`);
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { ok: boolean; betaApplicantId: null };
    expect(json.ok).toBe(true);
    expect(json.betaApplicantId).toBeNull();
    expect(pgQuery).not.toHaveBeenCalled();
    expect(flag.isBetaGateEnabled).toHaveBeenCalledTimes(1);
  });

  test("gate on + no Authorization header → 403 pact_auth_not_in_beta", async () => {
    const pgQuery = vi.fn();
    const app = makeApp({ pgQuery, flag: flagOn() });

    const resp = await app.request(`/v1/${SLUG}/`);
    expect(resp.status).toBe(403);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe(BETA_GATE_ERROR);
    // DB should never be consulted when the header is absent.
    expect(pgQuery).not.toHaveBeenCalled();
  });

  test("gate on + non-Bearer Authorization header → 403", async () => {
    const pgQuery = vi.fn();
    const app = makeApp({ pgQuery, flag: flagOn() });

    const resp = await app.request(`/v1/${SLUG}/`, {
      headers: { authorization: "Basic abc" },
    });
    expect(resp.status).toBe(403);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe(BETA_GATE_ERROR);
    expect(pgQuery).not.toHaveBeenCalled();
  });

  test("gate on + valid active key → next() called, betaApplicantId + apiKeyId on context", async () => {
    const plaintext = "pact_beta_test_key";
    const expectedHash = hashKey(plaintext);
    const pgQuery = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "key_123",
          beta_applicant_id: "applicant_abc",
          status: "active",
        },
      ],
    });
    const app = makeApp({ pgQuery, flag: flagOn() });

    const resp = await app.request(`/v1/${SLUG}/`, {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as {
      ok: boolean;
      betaApplicantId: string;
      apiKeyId: string;
    };
    expect(json.ok).toBe(true);
    expect(json.betaApplicantId).toBe("applicant_abc");
    expect(json.apiKeyId).toBe("key_123");
    expect(pgQuery).toHaveBeenCalledTimes(1);
    expect(pgQuery).toHaveBeenCalledWith(expect.any(String), [expectedHash]);
  });

  test("gate on + revoked key (status != 'active') → 403", async () => {
    const pgQuery = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "key_revoked",
          beta_applicant_id: "applicant_abc",
          status: "revoked",
        },
      ],
    });
    const app = makeApp({ pgQuery, flag: flagOn() });

    const resp = await app.request(`/v1/${SLUG}/`, {
      headers: { authorization: "Bearer pact_beta_revoked" },
    });
    expect(resp.status).toBe(403);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe(BETA_GATE_ERROR);
  });

  test("gate on + unknown key (no row) → 403", async () => {
    const pgQuery = vi.fn().mockResolvedValue({ rows: [] });
    const app = makeApp({ pgQuery, flag: flagOn() });

    const resp = await app.request(`/v1/${SLUG}/`, {
      headers: { authorization: "Bearer pact_beta_unknown" },
    });
    expect(resp.status).toBe(403);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe(BETA_GATE_ERROR);
  });

  test("flag DB error + env fallback PACT_BETA_GATE_ENABLED=true → enforces gate", async () => {
    // System-flag DB read throws; env fallback says "on". The DB on the
    // flag side is independent of the api_keys lookup, which here returns
    // no row → 403.
    const flagPgQuery = vi.fn().mockRejectedValue(new Error("flag DB down"));
    const flag = createSystemFlagReader(
      { query: flagPgQuery } as never,
      {
        envReader: () => "true",
        now: () => 1_700_000_000_000,
      },
    );

    const apiKeyPgQuery = vi.fn().mockResolvedValue({ rows: [] });
    const app = makeApp({ pgQuery: apiKeyPgQuery, flag });

    const resp = await app.request(`/v1/${SLUG}/`, {
      headers: { authorization: "Bearer pact_beta_unknown" },
    });
    expect(resp.status).toBe(403);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe(BETA_GATE_ERROR);
    // The flag itself was consulted via the env fallback.
    expect(flagPgQuery).toHaveBeenCalledTimes(1);
    // The api_keys lookup ran because the gate was enforced.
    expect(apiKeyPgQuery).toHaveBeenCalledTimes(1);
  });

  test("flag DB error + env fallback PACT_BETA_GATE_ENABLED=false → passes through", async () => {
    const flagPgQuery = vi.fn().mockRejectedValue(new Error("flag DB down"));
    const flag = createSystemFlagReader(
      { query: flagPgQuery } as never,
      {
        envReader: () => "false",
        now: () => 1_700_000_000_000,
      },
    );

    const apiKeyPgQuery = vi.fn();
    const app = makeApp({ pgQuery: apiKeyPgQuery, flag });

    const resp = await app.request(`/v1/${SLUG}/`);
    expect(resp.status).toBe(200);
    expect(apiKeyPgQuery).not.toHaveBeenCalled();
  });

  test("gate on + api_keys DB error → 403 (fail closed)", async () => {
    // Separate from the flag-side fallback above: when the api_keys
    // lookup itself fails, we deny rather than letting traffic through.
    const pgQuery = vi.fn().mockRejectedValue(new Error("api_keys DB down"));
    const app = makeApp({ pgQuery, flag: flagOn() });

    const resp = await app.request(`/v1/${SLUG}/`, {
      headers: { authorization: "Bearer pact_beta_anything" },
    });
    expect(resp.status).toBe(403);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe(BETA_GATE_ERROR);
  });
});
