# Mainnet Secrets Audit — `pact-network` (project 224627201825)

**Date:** 2026-05-07
**Auditor:** security engineer agent
**Scope:** all secrets in GCP project `pact-network`, their versions, IAM, and project-level secret access.
**Trigger:** during the first end-to-end mainnet smoke we discovered `PACT_INDEXER_PUSH_SECRET` had two enabled `REPLACE_ME` placeholder versions (v1, v2) sitting behind the real value (v3). A `:latest` rollback would have mounted `REPLACE_ME` and opened the indexer push API to anyone sending `Bearer REPLACE_ME`. We checked every other secret for the same pattern.

---

## 1. Secrets inventory

| # | Secret name                       | Versions | State at audit start                                  | Mounted by (Cloud Run)                |
|---|-----------------------------------|----------|-------------------------------------------------------|---------------------------------------|
| 1 | `PACT_ALCHEMY_API_KEY`            | 3        | v1 enabled, v2 enabled, v3 enabled (latest)           | `pact-market-proxy`                   |
| 2 | `PACT_DB_PASSWORD`                | 2        | v1 enabled, v2 enabled (latest)                       | (no Cloud Run mount; Cloud SQL only)  |
| 3 | `PACT_HELIUS_API_KEY`             | 2        | v1 enabled, v2 enabled (latest)                       | `pact-market-proxy`                   |
| 4 | `PACT_INDEXER_PUSH_SECRET`        | 3        | v1 enabled, v2 enabled, v3 enabled (latest)           | `pact-indexer`, `pact-settler`        |
| 5 | `PACT_SETTLEMENT_AUTHORITY_BS58`  | 1        | v1 enabled (latest)                                   | `pact-settler` (env var URI form)     |
| 6 | `PACT_SETTLEMENT_AUTHORITY_JSON`  | 2        | v1 enabled, v2 enabled (latest)                       | (not currently mounted)               |

**Total secrets:** 6. **Total versions:** 13. **All Cloud Run references resolve via `:latest`** — there is no version pinning, so any `:latest` rollback (manual `gcloud secrets versions enable` of an older version, or restored TF state) immediately changes what every service sees.

## 2. Placeholder versions found

Read first 8-32 chars of every version. Detected `REPLACE_ME` literal in 7 versions across 5 secrets. None of the placeholder versions were currently aliased by `:latest`.

| Secret                            | Version | First chars         | Disposition                      |
|-----------------------------------|---------|---------------------|----------------------------------|
| `PACT_ALCHEMY_API_KEY`            | 1       | `REPLACE_ME`        | **DISABLED** (this audit)        |
| `PACT_ALCHEMY_API_KEY`            | 2       | `REPLACE_ME`        | **DISABLED** (this audit)        |
| `PACT_DB_PASSWORD`                | 1       | `REPLACE_ME`        | **DISABLED** (this audit)        |
| `PACT_HELIUS_API_KEY`             | 1       | `REPLACE_ME`        | **DISABLED** (this audit)        |
| `PACT_INDEXER_PUSH_SECRET`        | 1       | `REPLACE_ME`        | **DISABLED** (this audit)        |
| `PACT_INDEXER_PUSH_SECRET`        | 2       | `REPLACE_ME`        | **DISABLED** (this audit)        |
| `PACT_SETTLEMENT_AUTHORITY_JSON`  | 1       | `REPLACE_ME`        | **DISABLED** (this audit)        |

Latest versions (real values, not pasted here, only first 8 chars verified non-placeholder):
- `PACT_ALCHEMY_API_KEY:3` → `92c236cc…`
- `PACT_DB_PASSWORD:2` → `pi-qzAds…`
- `PACT_HELIUS_API_KEY:2` → `X0FRvIFi…`
- `PACT_INDEXER_PUSH_SECRET:3` → `8e185d94…`
- `PACT_SETTLEMENT_AUTHORITY_BS58:1` → bs58-formatted, length-checked
- `PACT_SETTLEMENT_AUTHORITY_JSON:2` → `[152,237…` (Solana keypair JSON byte array)

**No escalation required.** No `:latest` alias points to a placeholder. All running services are on real values.

Disable is reversible (`gcloud secrets versions enable …`). No version was destroyed.

## 3. IAM findings

### 3.1 Secret-level IAM
Out of 6 secrets, only **1** has any secret-level IAM bindings:

| Secret                            | Secret-level bindings                                         |
|-----------------------------------|---------------------------------------------------------------|
| `PACT_SETTLEMENT_AUTHORITY_BS58`  | `pact-settler-sa` → `roles/secretmanager.secretAccessor`      |
| every other secret                | **none** — relies entirely on project-level grants            |

This means access to `PACT_DB_PASSWORD`, `PACT_HELIUS_API_KEY`, `PACT_ALCHEMY_API_KEY`, `PACT_INDEXER_PUSH_SECRET`, `PACT_SETTLEMENT_AUTHORITY_JSON` is gated only by project-level `roles/secretmanager.secretAccessor`, which is broader than necessary — every account with that role can read every secret.

No `allUsers` or `allAuthenticatedUsers` bindings on any secret. No public exposure.

### 3.2 Project-level secret access
```
roles/secretmanager.secretAccessor
  - serviceAccount:224627201825-compute@developer.gserviceaccount.com   ← drift
  - serviceAccount:pact-indexer-sa@pact-network.iam.gserviceaccount.com
  - serviceAccount:pact-market-proxy-sa@pact-network.iam.gserviceaccount.com
  - serviceAccount:pact-settler-sa@pact-network.iam.gserviceaccount.com
```

Findings:
- **Drift:** `224627201825-compute@developer.gserviceaccount.com` (the default Compute Engine service account) has `secretmanager.secretAccessor` at the project level. This SA is implicitly used by Cloud Build, any GCE VM created without an explicit SA, and several GCP managed jobs. It should not have access to mainnet secrets.
- The three `pact-*-sa` service accounts correctly have project-level access. They should be moved to per-secret bindings to enforce least privilege (e.g. `pact-indexer-sa` only needs `PACT_INDEXER_PUSH_SECRET`, not `PACT_SETTLEMENT_AUTHORITY_*`).
- **No human user accounts** have project-level `secretmanager` grants (good).
- `rick@quantum3labs.com` has `roles/owner` at project level (transitively grants secret access). Expected for the project owner during launch; flag to revisit when team grows.

## 4. Concrete fixes applied

1. Disabled 7 placeholder versions across 5 secrets (table in §2). All disables are reversible.
2. Verified `:latest` for every secret resolves to a non-placeholder value.
3. Verified every Cloud Run service mounts `secretName/versions/latest`, so the disable closes the rollback-to-placeholder vector.

## 5. Concrete fixes recommended (PR-style action list)

- [ ] **Pin Cloud Run secret mounts to a specific version, not `:latest`.** Right now any `:latest` change instantly affects production. Pin to e.g. `:3` and bump explicitly during rotation. Cuts blast radius of an accidental rollback or version-enable.
- [ ] **Remove `roles/secretmanager.secretAccessor` from the default compute SA** (`224627201825-compute@developer.gserviceaccount.com`). Cloud Build uses this SA — give Cloud Build its own dedicated SA if it actually needs secret access during build (it shouldn't for this stack).
- [ ] **Move from project-level to secret-level IAM.** Each service SA should have `secretmanager.secretAccessor` only on the specific secrets it mounts:
  - `pact-indexer-sa` → `PACT_INDEXER_PUSH_SECRET` only
  - `pact-market-proxy-sa` → `PACT_HELIUS_API_KEY`, `PACT_ALCHEMY_API_KEY` only
  - `pact-settler-sa` → `PACT_INDEXER_PUSH_SECRET`, `PACT_SETTLEMENT_AUTHORITY_BS58` only
  Then revoke the project-level grant.
- [ ] **Codify secret bindings in Terraform.** Today secrets and their IAM live outside `terraform-gcp/pact-network-prod`; codify so future drift fails plan, and so review-by-PR is enforced. Use `google_secret_manager_secret_iam_member` with explicit `secret_id` + `member`.
- [ ] **Stop creating placeholder versions during bootstrap.** Whatever bootstrap script created `REPLACE_ME` v1+v2 for every secret on 2026-05-07 06:07 needs to either (a) require the real value at create time, or (b) leave the secret with zero versions until the real value is added. A placeholder version is a footgun, period.
- [ ] **Add a CI check that rejects placeholder values.** Pre-merge job fetches the first 32 bytes of `:latest` for each named mainnet secret (via WIF, no human access needed) and fails the build if it matches `REPLACE_ME|CHANGEME|TODO|placeholder|test|secret123`.
- [ ] **Define a rotation policy.** No secret has an expiration set. Set Secret Manager rotation period (90d for API keys, 180d for `PACT_SETTLEMENT_AUTHORITY_*`) and route rotation alerts to PagerDuty.
- [ ] **Replication policy:** all secrets currently use the implicit default. Make the replication choice explicit in TF (`replication { auto {} }` or `replication { user_managed { replicas = […] } }`) so future secrets don't end up in unintended regions.

## 6. Open follow-ups

- **Naming-convention drift** caused last week's incident (`PACT_INDEXER_PUSH_SECRET` mounted as that exact name, but code reads `INDEXER_PUSH_SECRET`). Standardize one of:
  - Code uses prefixed names (`process.env.PACT_INDEXER_PUSH_SECRET`) — preferred since the prefix is namespaceful.
  - Cloud Run env var name strips the prefix at mount time (current pattern, fragile).
  Pick one and grep the codebase before each new secret is added.
- **`PACT_SETTLEMENT_AUTHORITY_JSON` is no longer mounted by anything** but still has 2 versions enabled. Confirm it's not needed (the BS58 form is what's mounted) and either delete the secret or document why it stays.
- **No secret-rotation runbook.** Write one. Include: how to rotate without downtime (add new version, point `:latest`, redeploy services, observe, then disable old version after 24h), and how to revoke.
- **Audit log query for secret access** is not yet in place. Add a Cloud Logging query that alerts on any `AccessSecretVersion` event from a non-service-account principal — would catch a stolen credential pulling secrets.
- **`PACT_DB_PASSWORD` has no Cloud Run mount** in any service. Confirm where it's actually consumed (Cloud SQL Auth Proxy? a job? an external client?) and tighten the IAM accordingly.
- **`default-backend` Cloud Run service** has no env config exposed in this audit. Verify it is not consuming any secret out-of-band, and consider removing it if it's a leftover scaffold.

---

**Summary:** 6 secrets, 13 versions, 7 placeholders found and disabled, 0 escalations needed, 1 IAM drift item flagged (default compute SA), 6 hardening recommendations queued, 6 follow-ups open.
