# pact-dummy-upstream — Vercel deploy runbook (dummy.pactnetwork.io)

Step-by-step deploy for the **dummy-upstream** service: a deliberately-flaky HTTP
upstream used to exercise the Pact breach/claim path on demand (and for demos).
Public, unauthenticated, stateless — **no env vars, no secrets**.

It lives in this monorepo at `packages/dummy-upstream/` (a tiny Hono service) and
is deployed to **Vercel** as a single Node serverless function. The Vercel project
points at this repo with **Root Directory = `packages/dummy-upstream`**.

| Thing | Value |
|---|---|
| Package | `packages/dummy-upstream/` (`@pact-network/dummy-upstream`) |
| Public hostname | `https://dummy.pactnetwork.io` |
| Platform | Vercel (serverless function, Node.js 20.x) |
| Vercel project root dir | `packages/dummy-upstream` |
| Function entry | `packages/dummy-upstream/api/index.ts` (`hono/vercel` adapter → `createApp()`) |
| Routing | `packages/dummy-upstream/vercel.json` — rewrites `/(.*)` → `/api/index` |
| Build command | none (`vercel.json` `buildCommand: ""`) — Vercel bundles `api/index.ts` directly |
| Local dev / `docker run` | still `src/index.ts` (`@hono/node-server`) on `$PORT` (default `8080`); the `Dockerfile` stays, it's just no longer the deploy path |

> **History:** this service was originally going to run on GCP Cloud Run (the same
> build → deploy GitHub Actions pattern as the other `pact-network` services). That
> route was abandoned in favour of Vercel — it's a tiny stateless demo stub, not
> worth a Cloud Run service + Artifact Registry image + domain mapping. The old
> Cloud Run wiring (the `pact-dummy-upstream` `service_name` option in
> `build-pact-network.yaml` / `deploy-pact-network.yaml`, and `deploy/dummy-upstream/main.tf`)
> has been removed. See §6 for the (already-deployed, inert) Cloud Run service that
> still needs tearing down by whoever has prod access.

---

## 0. Pre-flight

- [ ] `packages/dummy-upstream/` is on the branch you're deploying (it's in the
      monorepo — `api/index.ts`, `vercel.json`, `src/app.ts`, `src/x402.ts`, `src/index.ts`).
- [ ] You have access to the `pactnetwork` Vercel team (or whichever Vercel account
      owns the project) — `vercel login`, or a `VERCEL_TOKEN`.
- [ ] You know who manages DNS for `pactnetwork.io` (a `CNAME` needs adding there —
      this repo does not manage that zone). The LB-fronted subdomains (`api.` /
      `indexer.` / `app.`) use A records to the shared HTTPS load balancer;
      `demo.pactnetwork.io` is a separate repo. `dummy.` will be a CNAME to Vercel.

---

## 1. Create the Vercel project (one-time)

Via the Vercel dashboard:

1. **Add New… → Project → Import Git Repository** → `pactnetwork/pact-monitor`.
2. **Configure Project:**
   - **Root Directory:** `packages/dummy-upstream` (click *Edit*, pick the subdir).
   - **Framework Preset:** `Other` (the package has no framework; `vercel.json`
     already sets `"framework": null`).
   - **Build & Output Settings:** leave defaults — `vercel.json` overrides them
     (`buildCommand: ""`, no output dir; the serverless function in `api/` is
     auto-detected).
   - **Node.js Version:** `20.x` (also pinned via `engines.node` in the package's
     `package.json`, so this is belt-and-braces).
   - **Environment Variables:** none. This service takes no env / secrets.
3. **Production Branch:** set to the branch you want push-to-deploy from (e.g.
   `develop` or `main`, matching how the rest of the repo deploys). Or leave it and
   deploy manually with `vercel deploy --prod` (see §2).

Or via CLI from the repo root:

```bash
cd packages/dummy-upstream
vercel link            # link this dir to a new/existing Vercel project
# (answer: scope = pactnetwork team, project = pact-dummy-upstream, root dir = . )
```

`vercel.json` (committed) already encodes the routing and the no-build setup:

```json
{
  "framework": null,
  "buildCommand": "",
  "rewrites": [{ "source": "/(.*)", "destination": "/api/index" }]
}
```

You can validate the build locally without any auth/token:

```bash
cd packages/dummy-upstream
npx --yes vercel build      # → .vercel/output/ with functions/api/index.func (runtime nodejs20.x)
```

---

## 2. Deploy

**Push-to-deploy** (if you set a Production Branch in §1): push to that branch and
Vercel builds + deploys automatically.

**Manual / CLI:**

```bash
cd packages/dummy-upstream
vercel deploy --prod        # builds on Vercel and promotes to production
# or, with a prebuilt output:
#   npx vercel build
#   vercel deploy --prebuilt --prod
```

Sanity-check the auto-assigned `*.vercel.app` URL before touching DNS:

```bash
curl -s https://<project>.vercel.app/health
# expect: {"status":"ok","service":"pact-dummy-upstream"}
```

---

## 3. Add the custom domain `dummy.pactnetwork.io`

In the Vercel project → **Settings → Domains → Add** → `dummy.pactnetwork.io`.

Vercel will show the DNS record to add. For a **subdomain** it's a `CNAME`:

| Name | Type | Value |
|---|---|---|
| `dummy` (i.e. `dummy.pactnetwork.io`) | `CNAME` | `cname.vercel-dns.com.` |

(If this were an apex domain Vercel would instead want an `A` record to
`76.76.21.21` — not applicable here, `dummy.` is a subdomain, so it's the CNAME.)

---

## 4. Add the DNS record at the pactnetwork.io registrar

Add the record above at **whoever manages `pactnetwork.io` DNS** (this repo does
not manage that zone). Concretely:

```
dummy   CNAME   cname.vercel-dns.com.
```

(TTL whatever the zone default is; 300s is fine.)

Vercel auto-provisions a managed TLS cert once the CNAME resolves; the domain shows
"Invalid Configuration" / "pending" in the dashboard until then — that's expected,
usually clears within a few minutes.

---

## 5. Verify

```bash
# health endpoint
curl -s https://dummy.pactnetwork.io/health
# expect: {"status":"ok","service":"pact-dummy-upstream"}

# the deliberate-failure path returns 503
curl -i 'https://dummy.pactnetwork.io/quote/AAPL?fail=1'
# expect: HTTP/2 503 ... {"error":"upstream_unavailable",...} — exercises the breach path

# the happy path (no toggles) returns 200 with a quote body
curl -s 'https://dummy.pactnetwork.io/quote/AAPL'
# expect: 200, {"symbol":"AAPL","price":"287.90","currency":"USD","source":"pact-dummy-upstream","ts":<ms>}
```

The full `?fail= / ?status= / ?latency= / ?body= / ?x402=` toggle contract is owned
by `packages/dummy-upstream/` — see that package's README and tests.

If `curl` against the `*.vercel.app` URL works but `https://dummy.pactnetwork.io`
doesn't:
- "Invalid Configuration" in Vercel / NXDOMAIN → CNAME not added or not propagated yet.
- TLS error / cert warning → cert still provisioning, wait a few minutes.
- 404 from Vercel on every path → check `vercel.json` is in `packages/dummy-upstream/`
  and the project Root Directory is `packages/dummy-upstream` (the rewrite + the
  `api/index.ts` function both have to be inside the project root).

---

## 6. Teardown of the abandoned Cloud Run service

A `pact-dummy-upstream` Cloud Run service was already deployed (privately) in the
`pact-network-prod` project before the switch to Vercel. It's inert — it 403s
(no public-invoker IAM, no domain mapping) — but it's cruft. Whoever has prod
access should remove it:

```bash
gcloud run services delete pact-dummy-upstream \
  --region asia-southeast1 --project pact-network-prod --quiet

# and (optional) the image(s) in Artifact Registry, if any were pushed:
gcloud artifacts docker images delete \
  asia-southeast1-docker.pkg.dev/pact-network-prod/pact-network/pact-dummy-upstream \
  --project pact-network-prod --delete-tags --quiet
```

(There is no Terraform / GitHub Actions wiring left to clean up — `deploy/dummy-upstream/main.tf`
is deleted, and `pact-dummy-upstream` is no longer a `service_name` option in
`build-pact-network.yaml` / `deploy-pact-network.yaml`.)

---

## Summary of what needs doing outside this repo

| Item | Owner | Status |
|---|---|---|
| Create the Vercel project (import `pactnetwork/pact-monitor`, Root Directory = `packages/dummy-upstream`, framework = Other, Node 20.x) | operator | one-time setup |
| Add custom domain `dummy.pactnetwork.io` in the Vercel project | operator | after first deploy |
| Add `CNAME  dummy → cname.vercel-dns.com.` at the pactnetwork.io DNS provider | whoever manages pactnetwork.io DNS | manual |
| Delete the inert Cloud Run `pact-dummy-upstream` service in `pact-network-prod` | whoever has prod access | cleanup |
