// SystemFlagReader — short-TTL Postgres-backed boolean flag reader used by
// the private beta gate middleware. Mirrors the lazy-reload pattern from
// `lib/allowlist.ts`: the cached value is reused while fresh; on first call
// after the TTL expires we issue one in-flight reload. If that reload
// fails (DB down, table missing during deploy, etc.) we fall back to the
// `PACT_BETA_GATE_ENABLED` env var so the gate behavior remains defined.
//
// PRD reference: `docs/pact-network/private-beta-gate-prd.md` — section
// "Feature flag". The flag row lives at `system_flags(key, enabled,
// updated_at)` and is consulted on every proxy request via this reader.
//
// Cache scope is in-process per Cloud Run instance; the 30s TTL bounds the
// staleness window across the fleet without coordination.

import type { Pool } from "pg";

const DEFAULT_TTL_MS = 30_000;
const FLAG_KEY = "beta_gate_enabled";

export interface SystemFlagReader {
  isBetaGateEnabled(): Promise<boolean>;
  bust(): void;
}

export interface SystemFlagReaderOptions {
  ttlMs?: number;
  /**
   * When true (default), DB read errors fall back to the
   * `PACT_BETA_GATE_ENABLED` env var. When false, errors propagate.
   */
  envFallback?: boolean;
  /**
   * Injectable env reader for tests. Defaults to `process.env`.
   */
  envReader?: () => string | undefined;
  /**
   * Injectable clock for tests.
   */
  now?: () => number;
}

type PgLike = Pick<Pool, "query">;

export function createSystemFlagReader(
  pg: PgLike,
  opts: SystemFlagReaderOptions = {},
): SystemFlagReader {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const envFallback = opts.envFallback ?? true;
  const envReader =
    opts.envReader ?? (() => process.env.PACT_BETA_GATE_ENABLED);
  const now = opts.now ?? (() => Date.now());

  let cached: boolean | null = null;
  let loadedAt = 0;
  let inflight: Promise<boolean> | null = null;

  function readEnvFlag(): boolean {
    const raw = envReader();
    return raw === "true";
  }

  async function reload(): Promise<boolean> {
    try {
      const { rows } = await pg.query<{ enabled: boolean }>(
        "SELECT enabled FROM system_flags WHERE key = $1 LIMIT 1",
        [FLAG_KEY],
      );
      const value = rows[0]?.enabled === true;
      cached = value;
      loadedAt = now();
      return value;
    } catch (err) {
      if (envFallback) {
        const fallback = readEnvFlag();
        // Cache the fallback so we don't hammer a sick DB. Next refresh
        // attempt happens after TTL expires.
        cached = fallback;
        loadedAt = now();
        // eslint-disable-next-line no-console
        console.info(
          "[system-flag] DB read failed, using PACT_BETA_GATE_ENABLED env fallback",
          { value: fallback, error: (err as Error)?.message },
        );
        return fallback;
      }
      throw err;
    }
  }

  return {
    async isBetaGateEnabled(): Promise<boolean> {
      const fresh = cached !== null && now() - loadedAt <= ttlMs;
      if (fresh) return cached as boolean;
      if (inflight) return inflight;
      inflight = reload().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    bust(): void {
      cached = null;
      loadedAt = 0;
    },
  };
}
