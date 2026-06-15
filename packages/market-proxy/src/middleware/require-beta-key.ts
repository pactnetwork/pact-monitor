// requireBetaKey — admission gate for the private beta. When the
// `beta_gate_enabled` SystemFlag is on, every `/v1/:slug/*` request must
// carry a valid `Authorization: Bearer <api_key>` whose sha256 hex hash
// matches an active row in `api_keys`. Invalid or missing → 403 with
// `pact_auth_not_in_beta`. Valid → request flows into the downstream
// `verifyPactSignature` middleware and the proxy route.
//
// PRD reference: `docs/pact-network/private-beta-gate-prd.md` — section
// "Proxy gate enforcement".
//
// The hash algorithm matches `packages/backend/src/middleware/auth.ts`:
//   key_hash = sha256(plaintext_key) as hex
//
// Denials are logged at info — denial is normal beta traffic, not an
// error. A per-request DB-lookup timing line is emitted so SRE can see
// gate-induced latency separately from upstream/wrap timings.

import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Pool } from "pg";

import type { SystemFlagReader } from "../lib/system-flag.js";

export const BETA_GATE_ERROR = "pact_auth_not_in_beta";

type PgLike = Pick<Pool, "query">;

export interface RequireBetaKeyDeps {
  pg: PgLike;
  flag: SystemFlagReader;
}

interface ApiKeyRow {
  id: string;
  beta_applicant_id: string | null;
  status: string;
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function denied(reason: string, extra: Record<string, unknown> = {}): void {
  // info level — denial is expected during private beta.
  // eslint-disable-next-line no-console
  console.info("[beta-gate] denied", { reason, ...extra });
}

export function requireBetaKey(deps: RequireBetaKeyDeps): MiddlewareHandler {
  const { pg, flag } = deps;

  return async function requireBetaKeyMiddleware(c, next) {
    // 1. If the gate is off (default in dev/staging), pass through.
    const gateOn = await flag.isBetaGateEnabled();
    if (!gateOn) {
      return next();
    }

    // 2. Read Bearer token. Missing → 403.
    const authHeader = c.req.header("authorization") ?? c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      denied("missing_bearer");
      return c.json({ error: BETA_GATE_ERROR }, 403);
    }
    const plaintext = authHeader.slice("Bearer ".length).trim();
    if (plaintext.length === 0) {
      denied("empty_bearer");
      return c.json({ error: BETA_GATE_ERROR }, 403);
    }

    // 3. Hash + DB lookup. Fail closed: any DB error denies admission so a
    //    sick DB cannot accidentally let traffic through while the gate is
    //    asserted on.
    const hash = hashKey(plaintext);
    const startNs = process.hrtime.bigint();
    let row: ApiKeyRow | undefined;
    try {
      const result = await pg.query<ApiKeyRow>(
        "SELECT id, beta_applicant_id, status FROM api_keys WHERE key_hash = $1 LIMIT 1",
        [hash],
      );
      row = result.rows[0];
    } catch (err) {
      denied("db_error", { error: (err as Error)?.message });
      return c.json({ error: BETA_GATE_ERROR }, 403);
    } finally {
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      // info, not debug — surfaces DB lookup latency to SRE during beta.
      // eslint-disable-next-line no-console
      console.info("[beta-gate] lookup", {
        elapsedMs: Number(elapsedMs.toFixed(3)),
      });
    }

    // 4. No row or non-active row → 403. Status check matches the
    //    backend's `requireApiKey` semantics so revocation works the same
    //    way at both edges.
    if (!row || row.status !== "active") {
      denied(row ? "inactive_key" : "unknown_key");
      return c.json({ error: BETA_GATE_ERROR }, 403);
    }

    // 5. Attach identity for downstream handlers and pass through.
    c.set("betaApplicantId", row.beta_applicant_id);
    c.set("apiKeyId", row.id);
    return next();
  };
}
