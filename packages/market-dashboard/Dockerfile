# -----------------------------------------------------------------------------
# pact-market-dashboard — Next.js 15 (App Router) Cloud Run image
#
# NEXT_PUBLIC_* values are baked into the client bundle at BUILD time. They
# must be supplied as `--build-arg` flags by the GH workflow; passing them
# at runtime is too late.
#
# Pattern: mirrors packages/indexer/Dockerfile (debian-slim + openssl +
# corepack pnpm + workspace manifests + filtered build). Builds workspace
# dep @pact-network/protocol-v1-client first because the dashboard imports
# from it (lib/solana.ts).
# -----------------------------------------------------------------------------
FROM node:22-slim AS builder
WORKDIR /app

# openssl + ca-certificates kept for parity with indexer.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

# Workspace manifests — include protocol-v1-client (workspace dep)
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/market-dashboard/package.json ./packages/market-dashboard/
COPY packages/protocol-v1-client/package.json ./packages/protocol-v1-client/

# Install deps for dashboard + workspace deps it pulls in
RUN pnpm install --frozen-lockfile \
  --filter @pact-network/market-dashboard \
  --filter @pact-network/protocol-v1-client

# tsconfig.base.json — required because protocol-v1-client/tsconfig.json
# extends it. (Same pattern as packages/indexer/Dockerfile.)
COPY tsconfig.base.json ./

# Build protocol-v1-client first so the dashboard can import from its dist/
COPY packages/protocol-v1-client/ ./packages/protocol-v1-client/
RUN pnpm --filter @pact-network/protocol-v1-client build

# Now the dashboard sources + the actual Next build
COPY packages/market-dashboard/ ./packages/market-dashboard/

# NEXT_PUBLIC_* build args — supplied by the workflow (`--build-arg`).
ARG NEXT_PUBLIC_INDEXER_URL
ARG NEXT_PUBLIC_USDC_MINT
ARG NEXT_PUBLIC_SOLANA_RPC
ENV NEXT_PUBLIC_INDEXER_URL=$NEXT_PUBLIC_INDEXER_URL
ENV NEXT_PUBLIC_USDC_MINT=$NEXT_PUBLIC_USDC_MINT
ENV NEXT_PUBLIC_SOLANA_RPC=$NEXT_PUBLIC_SOLANA_RPC

RUN pnpm --filter @pact-network/market-dashboard build

# -----------------------------------------------------------------------------
# Runtime stage — Next.js standalone server (no pnpm, minimal deps).
# -----------------------------------------------------------------------------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Standalone output bundles a node_modules + server.js. Public + .next/static
# are copied alongside it (Next docs: standalone does not include those).
COPY --from=builder /app/packages/market-dashboard/.next/standalone/ ./
COPY --from=builder /app/packages/market-dashboard/.next/static ./packages/market-dashboard/.next/static
# The dashboard does not have a `public/` dir today; conditional COPY would
# require BuildKit. Skipped — restore later if static assets land in public/.

EXPOSE 3000
CMD ["node", "packages/market-dashboard/server.js"]
