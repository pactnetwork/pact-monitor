# pact-dummy-upstream — flaky-API demo target for Pact Network premium coverage.
#
# Mirrors packages/market-proxy/Dockerfile (multi-stage pnpm workspace build →
# slim runtime). Build context = repo root. This service is simpler than
# market-proxy: it has no workspace dependencies and needs no env vars.

FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/dummy-upstream/package.json packages/dummy-upstream/
RUN pnpm install --frozen-lockfile --filter @pact-network/dummy-upstream

COPY tsconfig.base.json ./
COPY packages/dummy-upstream packages/dummy-upstream
RUN pnpm --filter @pact-network/dummy-upstream build

# -----------------------------------------------------------------------------
# Runtime stage — fresh `pnpm install --prod` instead of copying
# node_modules across stages. Copying /app/node_modules from the builder
# loses pnpm's symlink-to-.pnpm layout and breaks ESM resolution of
# @hono/node-server at runtime.
# -----------------------------------------------------------------------------
FROM node:22-alpine
LABEL service="pact-dummy-upstream"
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/dummy-upstream/package.json packages/dummy-upstream/
RUN pnpm install --frozen-lockfile --prod --filter @pact-network/dummy-upstream

COPY --from=builder /app/packages/dummy-upstream/dist packages/dummy-upstream/dist

WORKDIR /app/packages/dummy-upstream
EXPOSE 8080
CMD ["node", "dist/index.js"]
