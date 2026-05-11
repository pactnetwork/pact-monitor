# pact-dummy-upstream — Cloud Run deploy runbook (dummy.pactnetwork.io)

Step-by-step deploy for the **pact-dummy-upstream** service: a deliberately-flaky
HTTP upstream used to exercise the Pact breach/claim path on demand (and for
demos). Public, unauthenticated, stateless — **no env vars, no secrets**.

| Thing | Value |
|---|---|
| Service name | `pact-dummy-upstream` |
| Public hostname | `https://dummy.pactnetwork.io` |
| GCP project | `pact-network` (project number `224627201825`) |
| Region | `asia-southeast1` |
| Artifact Registry repo | `pact-network` |
| Image | `asia-southeast1-docker.pkg.dev/pact-network/pact-network/pact-dummy-upstream:latest` |
| Dockerfile | `packages/dummy-upstream/Dockerfile` |
| Listen port | `$PORT` (Cloud Run injects `8080`) |
| Scale | `min=0`, `max=2` |
| Ingress | `all` |
| Auth | unauthenticated (`allUsers` → `roles/run.invoker`) |
| Terraform | `deploy/dummy-upstream/main.tf` (this repo, pending move to `devops/terraform-gcp/pact-network/`) |

> This follows the same build → deploy pattern as the other pact-network Cloud
> Run services (`build-pact-network.yaml` → `deploy-pact-network.yaml`). The only
> extra step vs. an LB-fronted service is the **domain mapping** + the **CNAME**,
> because this stub is exposed via a Cloud Run custom-domain mapping rather than
> through the shared HTTPS load balancer.

---

## 0. Dependencies / pre-flight

- [ ] **`packages/dummy-upstream/` exists on `main`.** Another agent is adding the
      package (`packages/dummy-upstream/Dockerfile`, listens on `$PORT`, exposes
      `/health` and `/quote/<symbol>?fail=…`). Confirm it's merged before running
      the build workflow:
      ```bash
      gh api repos/pactnetwork/pact-monitor/contents/packages/dummy-upstream/Dockerfile --jq .path
      ```
      If that 404s, the package PR hasn't landed yet — **stop and wait**.
- [ ] **`pact-dummy-upstream` is a valid `service_name` choice in both workflows.**
      `build-pact-network.yaml` and `deploy-pact-network.yaml` currently hard-code
      their `service_name` choice list (`pact-market-proxy` / `pact-settler` /
      `pact-indexer` / `pact-market-dashboard`) and the build workflow's
      "Resolve dockerfile path" `case` statement. The package PR (or a follow-up)
      must add `pact-dummy-upstream` to:
        - `build-pact-network.yaml` → `inputs.service_name.options` **and** the
          `case "${{ inputs.service_name }}"` block → `pact-dummy-upstream)
          echo "path=packages/dummy-upstream/Dockerfile"`
        - `deploy-pact-network.yaml` → `inputs.service_name.options`
      Check:
      ```bash
      gh api repos/pactnetwork/pact-monitor/contents/.github/workflows/build-pact-network.yaml --jq '.content' | base64 -d | grep -n dummy-upstream
      ```
      If `pact-dummy-upstream` is missing from the workflows, **that's a blocking
      dependency** — `gh workflow run … -f service_name=pact-dummy-upstream` will
      fail input validation. Note it and coordinate with the package PR.
- [ ] You can run `gh` against `pactnetwork/pact-monitor` (already authed) and have
      `gcloud` configured for project `pact-network` with rights to create domain
      mappings.
- [ ] You know who manages DNS for `pactnetwork.io` (a CNAME needs adding there —
      this repo does **not** manage that zone).

---

## 1. Build the image

```bash
gh workflow run build-pact-network.yaml \
  --repo pactnetwork/pact-monitor \
  --ref main \
  -f environment=production \
  -f service_name=pact-dummy-upstream
```

Wait for it to go green:

```bash
# grab the run id
RUN_ID=$(gh run list --repo pactnetwork/pact-monitor \
  --workflow build-pact-network.yaml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --repo pactnetwork/pact-monitor --exit-status
```

On success the image is at
`asia-southeast1-docker.pkg.dev/pact-network/pact-network/pact-dummy-upstream:<short-sha>`
and tagged `:latest`. (Verify if you want:
`gcloud artifacts docker images list asia-southeast1-docker.pkg.dev/pact-network/pact-network/pact-dummy-upstream --project pact-network`.)

---

## 2. Deploy to Cloud Run

```bash
gh workflow run deploy-pact-network.yaml \
  --repo pactnetwork/pact-monitor \
  --ref main \
  -f environment=production \
  -f service_name=pact-dummy-upstream
```

Wait:

```bash
RUN_ID=$(gh run list --repo pactnetwork/pact-monitor \
  --workflow deploy-pact-network.yaml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --repo pactnetwork/pact-monitor --exit-status
```

This does a bare `gcloud run deploy pact-dummy-upstream --image …:latest --region
asia-southeast1 --platform managed`. Because the service has **no env and no
secrets**, there's nothing to re-assert out of band (the `INDEXER_PUSH_SECRET`
re-assertion step in the workflow only fires for `pact-indexer`/`pact-settler`).

> **First deploy only:** if Terraform hasn't been applied yet (see §3) the service
> may not exist when the deploy workflow runs. Either apply Terraform first, or
> let the first `gcloud run deploy` create the service and then `terraform apply`
> to bring it under management. Order doesn't matter much for a no-env service —
> just make sure the public-invoker IAM (`allUsers` → `roles/run.invoker`) ends up
> set, whichever way the service got created.

Sanity-check the auto-assigned URL before touching DNS:

```bash
SVC_URL=$(gcloud run services describe pact-dummy-upstream \
  --region asia-southeast1 --project pact-network --format='value(status.url)')
curl -s "$SVC_URL/health"
# expect: {"status":"ok",...}
```

If that 403s, public IAM isn't set — fix with:
```bash
gcloud run services add-iam-policy-binding pact-dummy-upstream \
  --region asia-southeast1 --project pact-network \
  --member=allUsers --role=roles/run.invoker
```
(Terraform in `deploy/dummy-upstream/main.tf` declares this binding; this is just
the manual escape hatch for the first deploy.)

---

## 3. Apply Terraform (service of record)

The service definition + domain mapping live in `deploy/dummy-upstream/main.tf`
(this repo, header explains it belongs in `devops/terraform-gcp/pact-network/`).
When that file is in the devops Terraform root:

```bash
cd ~/devops/terraform-gcp/pact-network        # wherever the pact-network root is
terraform init
terraform plan      # review — should add module.pact_dummy_upstream + the domain mapping
terraform apply
terraform output dummy_upstream_dns_records   # the CNAME you need to add (see §4)
```

If you can't `terraform apply` yet (devops PR not merged), do §4 with the
`gcloud` commands below instead.

---

## 4. Create the domain mapping + add the CNAME

### 4a. Create the mapping

```bash
gcloud beta run domain-mappings create \
  --service pact-dummy-upstream \
  --domain dummy.pactnetwork.io \
  --region asia-southeast1 \
  --project pact-network
```

### 4b. Read back the DNS records it wants

```bash
gcloud beta run domain-mappings describe \
  --domain dummy.pactnetwork.io \
  --region asia-southeast1 \
  --project pact-network \
  --format='value(status.resourceRecords)'
```

For a **subdomain**, Cloud Run wants a single CNAME:

| Name | Type | Value |
|---|---|---|
| `dummy.pactnetwork.io` | `CNAME` | `ghs.googlehosted.com.` |

### 4c. Add the CNAME at the pactnetwork.io DNS provider

Add the record above at **whoever manages `pactnetwork.io` DNS** (this repo does
not manage that zone — the LB-fronted subdomains `api.` / `indexer.` / `app.` use
A records to the LB IP, and `demo.pactnetwork.io` is a separate repo). Concretely:

```
dummy   CNAME   ghs.googlehosted.com.
```

(TTL whatever the zone default is; 300s is fine.)

### 4d. Wait for the cert

After the CNAME resolves (`dig +short dummy.pactnetwork.io` → `ghs.googlehosted.com`
chain), Google auto-provisions a managed TLS cert. Watch:

```bash
gcloud beta run domain-mappings describe \
  --domain dummy.pactnetwork.io --region asia-southeast1 --project pact-network \
  --format='value(status.conditions)'
```

`CertificateProvisioning` → `Ready` usually takes 15–30 min. The mapping shows
"pending" until the CNAME is live — that's expected.

---

## 5. Verify

```bash
# health endpoint
curl -s https://dummy.pactnetwork.io/health
# expect: {"status":"ok",...}

# the deliberate-failure path returns 503
curl -i 'https://dummy.pactnetwork.io/quote/AAPL?fail=1'
# expect: HTTP/1.1 503 ... (Service Unavailable) — used to exercise the breach path

# the happy path (no fail flag) returns 200 with a quote body
curl -s 'https://dummy.pactnetwork.io/quote/AAPL'
# expect: 200, a JSON quote
```

(Exact response shapes are owned by `packages/dummy-upstream/` — `/health`
returns `{"status":"ok",...}` and `?fail=1` forces a 503; check that package's
README/tests for the full contract.)

If `curl` against the bare `*.run.app` URL works but `https://dummy.pactnetwork.io`
doesn't:
- 404 / "page not found" from Google → CNAME not propagated yet, or mapping not
  created.
- TLS error / cert warning → cert still provisioning, wait.
- 403 → public-invoker IAM missing on the service (see §2 fix).

---

## 6. Rollback / teardown

To take `dummy.pactnetwork.io` down and remove the service entirely:

```bash
# 1. Delete the domain mapping (frees the hostname; do this first)
gcloud beta run domain-mappings delete \
  --domain dummy.pactnetwork.io \
  --region asia-southeast1 \
  --project pact-network --quiet

# 2. Delete the Cloud Run service
gcloud run services delete pact-dummy-upstream \
  --region asia-southeast1 \
  --project pact-network --quiet

# 3. Remove the CNAME `dummy → ghs.googlehosted.com` at the pactnetwork.io DNS provider.

# 4. (optional) delete the image(s) from Artifact Registry
gcloud artifacts docker images delete \
  asia-southeast1-docker.pkg.dev/pact-network/pact-network/pact-dummy-upstream \
  --project pact-network --delete-tags --quiet
```

If managed via Terraform instead: `terraform destroy -target=module.pact_dummy_upstream
-target=google_cloud_run_domain_mapping.dummy_upstream` (then still remove the CNAME
manually). To roll back just a bad revision without tearing down:

```bash
gcloud run revisions list --service pact-dummy-upstream --region asia-southeast1 --project pact-network
gcloud run services update-traffic pact-dummy-upstream \
  --to-revisions=pact-dummy-upstream-0000X-xxx=100 \
  --region asia-southeast1 --project pact-network
```

---

## Summary of what needs doing outside this PR

| Item | Owner | Status |
|---|---|---|
| `packages/dummy-upstream/` package + Dockerfile | other agent (parallel PR) | dependency — confirm merged before §1 |
| Add `pact-dummy-upstream` to `build-pact-network.yaml` + `deploy-pact-network.yaml` `service_name` options (and the build workflow's dockerfile-path `case`) | other agent / follow-up | dependency — `gh workflow run … -f service_name=pact-dummy-upstream` fails until done |
| Move `deploy/dummy-upstream/main.tf` into `devops/terraform-gcp/pact-network/` | devops repo PR | pending |
| Add CNAME `dummy.pactnetwork.io → ghs.googlehosted.com.` at the pactnetwork.io DNS provider | whoever manages pactnetwork.io DNS | manual, after `gcloud beta run domain-mappings create` |
| Run build → deploy → domain-mapping → verify | operator | this runbook |
