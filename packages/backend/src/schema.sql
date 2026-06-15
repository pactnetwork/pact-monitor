CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Self-serve API key issuance challenges. Single-use nonces issued by
-- POST /api/v1/keys/self-serve/challenge and consumed by the matching
-- /self-serve issuance call after the caller signs the challenge with the
-- ed25519 keypair backing the agent_pubkey. Without this proof-of-ownership
-- step, anyone could mint a key bound to any wallet (codex review on PR
-- #50). Rows expire after a short TTL and the consumption is idempotent
-- via DELETE … RETURNING.
CREATE TABLE IF NOT EXISTS api_key_challenges (
  nonce        TEXT PRIMARY KEY,
  agent_pubkey TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_api_key_challenges_pubkey ON api_key_challenges(agent_pubkey);
CREATE INDEX IF NOT EXISTS idx_api_key_challenges_expires_at ON api_key_challenges(expires_at);

CREATE TABLE IF NOT EXISTS providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Unknown',
  base_url TEXT NOT NULL UNIQUE,
  wallet_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS call_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES providers(id),
  endpoint TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  status_code INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  classification TEXT NOT NULL CHECK (classification IN ('success', 'timeout', 'client_error', 'server_error', 'schema_mismatch')),
  payment_protocol TEXT CHECK (payment_protocol IN ('x402', 'mpp') OR payment_protocol IS NULL),
  payment_amount BIGINT,
  payment_asset TEXT,
  payment_network TEXT,
  payer_address TEXT,
  recipient_address TEXT,
  tx_hash TEXT,
  settlement_success BOOLEAN,
  agent_id TEXT,
  agent_pubkey TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_call_records_provider_id ON call_records(provider_id);
CREATE INDEX IF NOT EXISTS idx_call_records_timestamp ON call_records(timestamp);
CREATE INDEX IF NOT EXISTS idx_call_records_classification ON call_records(classification);

-- Idempotency guard: an agent's SDK client may re-flush the same record on
-- multiple sync cycles (e.g. during shutdown race). Without this partial
-- unique index, each re-flush would insert a fresh call_records row with a
-- new UUID, each deriving a distinct claim PDA on-chain and landing a fresh
-- refund. Keyed on the tuple that uniquely identifies a single agent call:
-- (agent_pubkey, timestamp, endpoint). Only enforced for rows that carry
-- an agent_pubkey (anonymous traffic can still be duplicated).
CREATE UNIQUE INDEX IF NOT EXISTS idx_call_records_agent_idempotency
  ON call_records(agent_pubkey, timestamp, endpoint)
  WHERE agent_pubkey IS NOT NULL;

CREATE TABLE IF NOT EXISTS backend_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route TEXT NOT NULL,
  method TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backend_metrics_created ON backend_metrics(created_at);
CREATE INDEX IF NOT EXISTS idx_backend_metrics_route ON backend_metrics(route);

CREATE TABLE IF NOT EXISTS analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  event_data JSONB NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'scorecard',
  session_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_type ON analytics_events(event_type);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created ON analytics_events(created_at);

-- Tracks the last time the premium-settler crank settled a given on-chain
-- policy. The crank uses this as a watermark so each call_record contributes
-- to exactly one settlement and doesn't get re-charged on subsequent cycles.
CREATE TABLE IF NOT EXISTS policy_settlements (
  policy_pda       TEXT PRIMARY KEY,
  last_settled_at  TIMESTAMPTZ NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS agent_pubkey TEXT;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
-- Drop any pre-existing index with the same name (legacy dev DBs may have a
-- non-unique variant), then recreate as UNIQUE. Tiny table, so the brief
-- AccessExclusiveLock during drop is microseconds and runs at boot before
-- traffic is accepted.
DROP INDEX IF EXISTS idx_api_keys_label;
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_label ON api_keys(label);
CREATE INDEX IF NOT EXISTS idx_api_keys_agent_pubkey ON api_keys(agent_pubkey);

-- F1: Referrer revenue share. An api_keys row can (optionally) be linked to
-- a referrer pubkey; every on-chain policy created from that key captures
-- the referrer + share_bps at creation time. Hard ceiling of 3000 bps
-- (30%) enforced at the CHECK; program will mirror the same ceiling.
-- Nullable: existing keys (pre-F1) have no referrer and settle two-way as
-- before.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS referrer_pubkey TEXT NULL;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS referrer_share_bps INTEGER NULL;
-- Enforces the (pubkey, share_bps) pair invariant: both null (cleared) or
-- both set with share_bps in [1, 3000]. The earlier check name allowed
-- share_bps=0 paired with a non-null pubkey, which the on-chain Pinocchio
-- policy rejects as InvalidRate. Drop-then-add inside a DO block so this is
-- safe to re-apply on boot regardless of whether the older constraint exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_referrer_share_bps_check'
  ) THEN
    ALTER TABLE api_keys DROP CONSTRAINT api_keys_referrer_share_bps_check;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_referrer_pair_check'
  ) THEN
    ALTER TABLE api_keys
      ADD CONSTRAINT api_keys_referrer_pair_check
      CHECK (
        (referrer_pubkey IS NULL AND referrer_share_bps IS NULL)
        OR (referrer_pubkey IS NOT NULL AND referrer_share_bps BETWEEN 1 AND 3000)
      );
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_api_keys_referrer ON api_keys(referrer_pubkey) WHERE referrer_pubkey IS NOT NULL;

CREATE TABLE IF NOT EXISTS claims (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_record_id  UUID NOT NULL REFERENCES call_records(id),
  provider_id     UUID NOT NULL REFERENCES providers(id),
  agent_id        TEXT,
  policy_id       TEXT,
  trigger_type    TEXT NOT NULL CHECK (trigger_type IN ('timeout', 'server_error', 'schema_mismatch', 'latency_sla')),
  call_cost       BIGINT,
  refund_pct      INTEGER NOT NULL,
  refund_amount   BIGINT,
  status          TEXT NOT NULL DEFAULT 'simulated' CHECK (status IN ('detected', 'simulated', 'submitted', 'settled', 'frozen')),
  tx_hash         TEXT,
  settlement_slot BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claims_provider_id ON claims(provider_id);
CREATE INDEX IF NOT EXISTS idx_claims_agent_id ON claims(agent_id);
CREATE INDEX IF NOT EXISTS idx_claims_status ON claims(status);
CREATE INDEX IF NOT EXISTS idx_claims_created_at ON claims(created_at);

-- F1: denormalized referrer for fast partner reads. Populated by the
-- policy-creation flow (when the on-chain fields land) + mirrored from the
-- api_keys.referrer_pubkey snapshot at claim time so the partners endpoint
-- avoids a JOIN back to api_keys. Partial index keeps it small until the
-- on-chain fields ship.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS referrer_pubkey TEXT NULL;
CREATE INDEX IF NOT EXISTS idx_claims_referrer
  ON claims(referrer_pubkey) WHERE referrer_pubkey IS NOT NULL;

-- Audit trail for /api/v1/faucet/drip. Not used for enforcement (rate limit
-- lives in @fastify/rate-limit), just a record of who got what and when so we
-- can retroactively spot abuse on the devnet test mint. Devnet-only; the
-- faucet is hard-gated off on mainnet by the genesis-hash check.
CREATE TABLE IF NOT EXISTS faucet_drips (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient   TEXT NOT NULL,
  amount      BIGINT NOT NULL,
  signature   TEXT NOT NULL,
  network     TEXT NOT NULL,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_faucet_drips_recipient_created
  ON faucet_drips(recipient, created_at);

-- ============================================================
-- Anti-fraud: premium adjustments
-- ============================================================
CREATE TABLE IF NOT EXISTS premium_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  provider_id UUID NOT NULL REFERENCES providers(id),
  loading_factor NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  reason TEXT,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(agent_id, provider_id)
);

-- ============================================================
-- Anti-fraud: outage events
-- ============================================================
CREATE TABLE IF NOT EXISTS outage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES providers(id),
  reporting_agents INTEGER NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  network_failure_rate NUMERIC(5,2)
);

CREATE INDEX IF NOT EXISTS idx_outage_events_provider
  ON outage_events(provider_id, started_at);

-- ============================================================
-- Anti-fraud: agent flags
-- ============================================================
CREATE TABLE IF NOT EXISTS agent_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id TEXT NOT NULL,
  agent_pubkey TEXT,
  flag_reason TEXT NOT NULL,
  flag_data JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'dismissed', 'suspended')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_flags_agent
  ON agent_flags(agent_id, status);

-- ============================================================
-- Private beta gate (PRD: private-beta-gate-prd.md)
-- Off-chain admission layer for market.pactnetwork.io/v1/{slug}/*.
-- beta_applicants captures Tally form submissions; system_flags carries
-- the runtime toggle that the proxy consults to enforce or bypass the
-- gate. api_keys.beta_applicant_id is the foreign key that ties an
-- issued API key back to the application it was minted for.
-- ============================================================
CREATE TABLE IF NOT EXISTS beta_applicants (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 TEXT,
  x_handle              TEXT,
  telegram_handle       TEXT,
  wallet_pubkey         TEXT,
  what_building         TEXT,
  urgency               TEXT,
  apis_currently_paying TEXT,
  tally_submission_id   TEXT UNIQUE,
  status                TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at           TIMESTAMPTZ,
  note                  TEXT
);
CREATE INDEX IF NOT EXISTS idx_beta_applicants_status
  ON beta_applicants(status, submitted_at);

CREATE TABLE IF NOT EXISTS system_flags (
  key        TEXT PRIMARY KEY,
  enabled    BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS beta_applicant_id UUID REFERENCES beta_applicants(id);
CREATE INDEX IF NOT EXISTS idx_api_keys_beta_applicant
  ON api_keys(beta_applicant_id) WHERE beta_applicant_id IS NOT NULL;

-- Tally questions added 2026-05-15 to mirror the published form at
-- tally.so/r/9qRXzQ. Inspected from the form's embedded JSON config:
--   display_name        — short-answer "How can we call you?"
--   persona             — dropdown "Which of these are you?"
--                         (AI Agent | API Merchant / AI Agent Merchant)
--   why_pact            — long-answer "Why are you considering trying out
--                         Pact Network?" — conditionally shown on the form
--   willing_to_feedback — checkbox "Would you be willing to provide
--                         feedback after use? We will give special offers
--                         to early testers." Stored as TEXT 'true'/'false'/
--                         NULL rather than BOOLEAN because Tally checkbox
--                         values arrive boolean and flow through the
--                         shared stringifyValue helper.
-- apis_currently_paying already exists from the initial ship. urgency
-- also exists but isn't asked on the current form — left nullable in case
-- it returns.
ALTER TABLE beta_applicants
  ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE beta_applicants
  ADD COLUMN IF NOT EXISTS persona TEXT;
ALTER TABLE beta_applicants
  ADD COLUMN IF NOT EXISTS why_pact TEXT;
ALTER TABLE beta_applicants
  ADD COLUMN IF NOT EXISTS willing_to_feedback TEXT;

-- ============================================================
-- CRM layer (added 2026-05-15)
-- Lightweight pipeline tracking on top of beta_applicants. Status stays
-- the admission gate (pending|approved|rejected — never weakens beyond
-- those three values). pipeline_stage is the deal-funnel position;
-- updated_at is auto-maintained by a trigger so "what's stale?" queries
-- are cheap. crm_activities is the append-only audit log.
-- ============================================================
ALTER TABLE beta_applicants
  ADD COLUMN IF NOT EXISTS pipeline_stage TEXT NOT NULL DEFAULT 'new'
    CHECK (pipeline_stage IN (
      'new',         -- just submitted
      'in_review',   -- ops has eyeballed it
      'contacted',   -- we've reached out
      'approved',    -- key issued; mirrors status='approved'
      'activated',   -- proxy has seen first authenticated call
      'rejected',    -- we said no
      'archived'     -- aged out / not pursuing
    ));
ALTER TABLE beta_applicants
  ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high'));
ALTER TABLE beta_applicants
  ADD COLUMN IF NOT EXISTS next_action TEXT;
ALTER TABLE beta_applicants
  ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ;
ALTER TABLE beta_applicants
  ADD COLUMN IF NOT EXISTS first_call_at TIMESTAMPTZ;
ALTER TABLE beta_applicants
  ADD COLUMN IF NOT EXISTS form_source TEXT NOT NULL DEFAULT 'tally:9qRXzQ';
ALTER TABLE beta_applicants
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_beta_applicants_pipeline
  ON beta_applicants(pipeline_stage, priority, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_beta_applicants_updated_at
  ON beta_applicants(updated_at DESC);

-- Auto-maintain updated_at on every UPDATE. Plain BEFORE trigger so a
-- single UPDATE to any column refreshes the timestamp without the caller
-- having to remember.
CREATE OR REPLACE FUNCTION beta_applicants_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_beta_applicants_updated_at ON beta_applicants;
CREATE TRIGGER trg_beta_applicants_updated_at
  BEFORE UPDATE ON beta_applicants
  FOR EACH ROW
  EXECUTE FUNCTION beta_applicants_set_updated_at();

-- Append-only activity log. Every meaningful event on an applicant gets
-- a row: 'submitted' (auto on apply), 'approved' (auto on approve),
-- 'stage_changed', 'contacted', 'note_added', 'first_call'. payload is
-- a free-form JSONB so the kind dictates the shape.
CREATE TABLE IF NOT EXISTS crm_activities (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beta_applicant_id  UUID NOT NULL REFERENCES beta_applicants(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL
    CHECK (kind IN (
      'submitted',
      'stage_changed',
      'priority_changed',
      'contacted',
      'approved',
      'rejected',
      'note_added',
      'first_call'
    )),
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor              TEXT NOT NULL DEFAULT 'system',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_activities_applicant
  ON crm_activities(beta_applicant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_activities_kind
  ON crm_activities(kind, created_at DESC);

-- ── CRM views (psql is the interface) ───────────────────────
-- Funnel: applicant counts per stage, ordered along the funnel.
CREATE OR REPLACE VIEW v_crm_funnel AS
WITH stage_order(stage, sort_idx) AS (
  VALUES
    ('new', 1),
    ('in_review', 2),
    ('contacted', 3),
    ('approved', 4),
    ('activated', 5),
    ('rejected', 6),
    ('archived', 7)
)
SELECT
  s.stage AS pipeline_stage,
  COALESCE(c.applicant_count, 0) AS applicant_count,
  COALESCE(c.high_priority_count, 0) AS high_priority_count
FROM stage_order s
LEFT JOIN (
  SELECT
    pipeline_stage,
    COUNT(*) AS applicant_count,
    COUNT(*) FILTER (WHERE priority = 'high') AS high_priority_count
  FROM beta_applicants
  GROUP BY pipeline_stage
) c ON c.pipeline_stage = s.stage
ORDER BY s.sort_idx;

-- Stuck deals: in a non-terminal stage and not touched in 7+ days.
-- Terminal stages (rejected, archived, activated) intentionally excluded.
CREATE OR REPLACE VIEW v_crm_stuck AS
SELECT
  id,
  COALESCE(display_name, email, x_handle, telegram_handle, 'unknown') AS who,
  pipeline_stage,
  priority,
  next_action,
  submitted_at,
  updated_at,
  EXTRACT(DAY FROM NOW() - updated_at)::int AS days_idle
FROM beta_applicants
WHERE pipeline_stage IN ('new', 'in_review', 'contacted', 'approved')
  AND updated_at < NOW() - INTERVAL '7 days'
ORDER BY priority DESC, updated_at ASC;

-- Recent activity: last 50 events across all applicants for at-a-glance
-- ops review.
CREATE OR REPLACE VIEW v_crm_recent AS
SELECT
  a.created_at,
  a.kind,
  a.actor,
  a.beta_applicant_id,
  COALESCE(b.display_name, b.email, b.x_handle, b.telegram_handle, 'unknown') AS who,
  b.pipeline_stage,
  a.payload
FROM crm_activities a
JOIN beta_applicants b ON b.id = a.beta_applicant_id
ORDER BY a.created_at DESC
LIMIT 50;

-- Activation funnel: how many approved keys have actually made a call.
-- Useful for spotting the gap between "we issued a key" and "they used it".
CREATE OR REPLACE VIEW v_crm_activation AS
SELECT
  COUNT(*) FILTER (WHERE status = 'approved') AS approved_total,
  COUNT(*) FILTER (WHERE pipeline_stage = 'activated') AS activated_total,
  CASE
    WHEN COUNT(*) FILTER (WHERE status = 'approved') = 0 THEN 0
    ELSE ROUND(
      100.0 * COUNT(*) FILTER (WHERE pipeline_stage = 'activated')
            / COUNT(*) FILTER (WHERE status = 'approved'),
      1
    )
  END AS activation_rate_pct,
  COUNT(*) FILTER (
    WHERE status = 'approved'
      AND pipeline_stage <> 'activated'
      AND approved_at < NOW() - INTERVAL '7 days'
  ) AS dormant_keys
FROM beta_applicants;

CREATE INDEX IF NOT EXISTS idx_agent_flags_status
  ON agent_flags(status, created_at);
