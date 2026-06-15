# pact-facilitator — facilitator.pact.network: the pay.sh / x402 premium-
# coverage register service. Brings Pact premium coverage to the `pact pay`
# (pay.sh) path via the side-call / receipt-registrar model.
#
# Mirrors packages/market-proxy/Dockerfile (multi-stage pnpm workspace build →
# slim runtime). Build context = repo root. Workspace dep: @pact-network/wrap.

FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/facilitator/package.json packages/facilitator/
COPY packages/wrap/package.json packages/wrap/
COPY packages/classifier/package.json packages/classifier/
RUN pnpm install --frozen-lockfile --filter @pact-network/facilitator --filter @pact-network/wrap --filter @pact-network/classifier

COPY tsconfig.base.json ./
# @pact-network/wrap imports @pact-network/classifier (rails-core SLA decision
# tree); build the classifier first so wrap's tsc resolves its dist/.d.ts.
COPY packages/classifier packages/classifier
COPY packages/wrap packages/wrap
COPY packages/facilitator packages/facilitator
RUN pnpm --filter @pact-network/classifier build && pnpm --filter @pact-network/wrap build && pnpm --filter @pact-network/facilitator build

# -----------------------------------------------------------------------------
# Runtime stage — fresh `pnpm install --prod` instead of copying
# node_modules across stages. Copying /app/node_modules from the builder
# loses pnpm's symlink-to-.pnpm layout and breaks ESM resolution of
# @hono/node-server at runtime.
# -----------------------------------------------------------------------------
FROM node:22-alpine
LABEL service="pact-facilitator"
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/facilitator/package.json packages/facilitator/
COPY packages/wrap/package.json packages/wrap/
COPY packages/classifier/package.json packages/classifier/
RUN pnpm install --frozen-lockfile --prod --filter @pact-network/facilitator --filter @pact-network/wrap --filter @pact-network/classifier

COPY --from=builder /app/packages/wrap/dist packages/wrap/dist
COPY --from=builder /app/packages/facilitator/dist packages/facilitator/dist
# @pact-network/classifier is runtime code reached via wrap's classifier.
COPY --from=builder /app/packages/classifier/dist packages/classifier/dist

WORKDIR /app/packages/facilitator
EXPOSE 8080
CMD ["node", "dist/index.js"]
