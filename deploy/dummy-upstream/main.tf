# =============================================================================
# pact-dummy-upstream — Cloud Run service + domain mapping (dummy.pactnetwork.io)
#
# CANONICAL LOCATION: this file belongs in the devops repo at
#   devops/terraform-gcp/pact-network/dummy-upstream.tf
# (the same Terraform that already defines pact-market-proxy / pact-settler /
#  pact-indexer / pact-market-dashboard). It is committed here in the
# pact-monitor repo as the SOURCE OF TRUTH pending that repo's PR, so the
# service definition lives next to the runbook (docs/dummy-upstream-deploy.md)
# and the package it deploys (packages/dummy-upstream/). When the devops PR
# lands, this file moves there verbatim and this copy can be deleted.
#
# Why this service exists: a deliberately-flaky upstream that the Pact proxy and
# demos can point at to exercise the breach/claim path on demand. Public,
# unauthenticated, stateless, no env, no secrets. The container listens on $PORT
# (Cloud Run injects 8080).
#
# IMPORTANT — env-var convention (matches the rest of pact-network):
#   The `cloud-run-service` module sets
#     lifecycle { ignore_changes = [template[0].containers[0].env] }
#   so env/secrets are managed out-of-band via `gcloud run services update`.
#   pact-dummy-upstream has NO env and NO secrets, so there is nothing to manage
#   out of band — the deploy workflow's bare `gcloud run deploy --image ...` is
#   all it ever needs.
#
# Project:  pact-network            (project number 224627201825)
# Region:   asia-southeast1
# AR repo:  pact-network            (image: .../pact-network/pact-dummy-upstream)
#
# Assumptions (not verified — this prep task does not run gcloud/terraform):
#   - The `cloud-run-service` module + `google` provider are already wired in
#     this Terraform root (they are, for the four existing services). The
#     `source` below mirrors how the other services reference the module;
#     adjust to match the real module ref in devops/terraform-gcp/pact-network/.
#   - A managed-SSL-enabled domain mapping is acceptable for this subdomain
#     (it is — same approach as any Cloud Run custom domain).
# =============================================================================

# ---------------------------------------------------------------------------
# Cloud Run service: pact-dummy-upstream
# Mirrors the stanza shape used for the other four pact-network services.
# ---------------------------------------------------------------------------
module "pact_dummy_upstream" {
  source = "../../modules/cloud-run-service"
  # ^ same relative module path the existing services use in
  #   devops/terraform-gcp/pact-network/. If the module is pinned to a registry
  #   ref instead (e.g. "app.terraform.io/quantum3labs/cloud-run-service/google"),
  #   match that here.

  project_id   = var.project_id   # "pact-network"
  region       = var.region       # "asia-southeast1"
  service_name = "pact-dummy-upstream"

  # Image is published by .github/workflows/build-pact-network.yaml:
  #   asia-southeast1-docker.pkg.dev/pact-network/pact-network/pact-dummy-upstream:latest
  # On the first `terraform apply` this tag may not exist yet; if the module
  # requires a concrete image, point it at :latest and let the deploy workflow
  # roll forward — or run the build workflow before the first apply.
  image = "${var.region}-docker.pkg.dev/${var.project_id}/pact-network/pact-dummy-upstream:latest"

  # Scale: a test upstream — scale to zero, cap small.
  min_instances = 0
  max_instances = 2

  # Public: anyone can reach it; ingress not restricted.
  ingress      = "all"
  allow_public = true   # module wires roles/run.invoker for allUsers (see IAM below)

  # Container listens on 8080 ($PORT). No env, no secrets; default 1cpu/512Mi
  # is plenty for a stub.
  container_port = 8080
  cpu            = "1"
  memory         = "512Mi"

  # No env vars, no secret mounts — explicit so a future reader doesn't add any
  # without realising the module's ignore_changes would then mask drift.
  env_vars = {}
  secrets  = {}

  # No Cloud SQL, no VPC connector, no service-specific SA needed — runs as the
  # default compute SA like a plain stateless container. (If the module
  # *requires* a service_account, pass the default compute SA:
  #   "${var.project_number}-compute@developer.gserviceaccount.com".)
}

# ---------------------------------------------------------------------------
# Public invoker IAM — allUsers : roles/run.invoker
# If `module.pact_dummy_upstream` already wires this when allow_public = true,
# this resource is redundant and should be removed; kept here explicit for the
# case where the module does NOT manage public IAM (the existing pact-network
# services front Cloud Run behind a load balancer, so the module may default to
# private). dummy.pactnetwork.io is a direct domain mapping → the service itself
# must allow unauthenticated traffic.
# ---------------------------------------------------------------------------
resource "google_cloud_run_v2_service_iam_member" "dummy_upstream_public" {
  project  = var.project_id
  location = var.region
  name     = "pact-dummy-upstream"
  role     = "roles/run.invoker"
  member   = "allUsers"

  depends_on = [module.pact_dummy_upstream]
}

# ---------------------------------------------------------------------------
# Direct service definition (reference / fallback)
#
# If the `cloud-run-service` module turns out not to fit a no-env public
# service, this is the equivalent bare `google_cloud_run_v2_service` — use ONE
# of (module above) or (this resource), not both. Left here so the reviewer can
# see exactly what gets created. Commented out by default.
# ---------------------------------------------------------------------------
# resource "google_cloud_run_v2_service" "pact_dummy_upstream" {
#   name     = "pact-dummy-upstream"
#   project  = var.project_id
#   location = var.region
#   ingress  = "INGRESS_TRAFFIC_ALL"
#
#   template {
#     scaling {
#       min_instance_count = 0
#       max_instance_count = 2
#     }
#     containers {
#       image = "${var.region}-docker.pkg.dev/${var.project_id}/pact-network/pact-dummy-upstream:latest"
#       ports {
#         container_port = 8080
#       }
#       resources {
#         limits = {
#           cpu    = "1"
#           memory = "512Mi"
#         }
#       }
#       # No env, no secrets.
#     }
#   }
#
#   # Match the rest of pact-network: env is managed out-of-band → ignore drift.
#   # (No-op here since there are no env vars, but keeps the convention.)
#   lifecycle {
#     ignore_changes = [template[0].containers[0].env]
#   }
# }

# ---------------------------------------------------------------------------
# Custom domain mapping: dummy.pactnetwork.io  →  pact-dummy-upstream
#
# Cloud Run domain mappings are still a beta/v1 (non-v2) resource in the
# google provider. `google_cloud_run_domain_mapping` is the supported one;
# there is no stable `google_cloud_run_v2_domain_mapping` at time of writing —
# if/when it lands, swap to it.
# ---------------------------------------------------------------------------
resource "google_cloud_run_domain_mapping" "dummy_upstream" {
  name     = "dummy.pactnetwork.io"
  location = var.region        # asia-southeast1
  project  = var.project_id    # pact-network

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = "pact-dummy-upstream"
  }

  depends_on = [module.pact_dummy_upstream]
}

# =============================================================================
# DNS RECORDS REQUIRED BY THE DOMAIN MAPPING
#
# `dummy.pactnetwork.io` is a SUBDOMAIN, so Cloud Run wants a single CNAME.
# After `terraform apply` (or `gcloud beta run domain-mappings create ...`),
# read the exact records back from the mapping's status:
#
#   terraform output dummy_upstream_dns_records
#   # or:
#   gcloud beta run domain-mappings describe \
#     --domain dummy.pactnetwork.io --region asia-southeast1 \
#     --project pact-network --format='value(status.resourceRecords)'
#
# It will be (subdomain → CNAME to Google's frontend):
#
#   +-----------------------------+-------+---------------------------+
#   | NAME                        | TYPE  | VALUE                     |
#   +-----------------------------+-------+---------------------------+
#   | dummy.pactnetwork.io        | CNAME | ghs.googlehosted.com.     |
#   +-----------------------------+-------+---------------------------+
#
# Add that record at whoever manages pactnetwork.io DNS. This repo does NOT
# manage the pactnetwork.io zone (no `google_dns_*` resources for it here), so
# the CNAME is a manual step — see docs/dummy-upstream-deploy.md.
#
# Once the CNAME resolves, Google provisions a managed TLS cert for
# dummy.pactnetwork.io automatically (status goes CertificateProvisioning ->
# Ready, typically 15-30 min). The mapping stays "pending" until the CNAME is
# live — that's expected, not an error.
#
# (For comparison: api.pactnetwork.io / indexer.pactnetwork.io / app.pactnetwork.io
#  are fronted by an HTTPS load balancer with A records to the LB IP, NOT domain
#  mappings. demo.pactnetwork.io lives in a separate repo. This service is a
#  one-off stub, so a plain domain mapping is the right tool — no LB needed.)
# =============================================================================

output "dummy_upstream_service_url" {
  description = "Auto-assigned *.run.app URL for pact-dummy-upstream (works immediately, before DNS)."
  value       = try(module.pact_dummy_upstream.service_url, null)
}

output "dummy_upstream_dns_records" {
  description = "DNS records that must be created at the pactnetwork.io DNS provider for the domain mapping to go live."
  value       = google_cloud_run_domain_mapping.dummy_upstream.status[0].resource_records
}
