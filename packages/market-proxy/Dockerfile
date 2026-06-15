FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/market-proxy/package.json packages/market-proxy/
COPY packages/protocol-v1-client/package.json packages/protocol-v1-client/
COPY packages/protocol-evm-v1-client/package.json packages/protocol-evm-v1-client/
COPY packages/shared/package.json packages/shared/
COPY packages/wrap/package.json packages/wrap/
COPY packages/classifier/package.json packages/classifier/
RUN pnpm install --frozen-lockfile \
  --filter @pact-network/market-proxy \
  --filter @q3labs/pact-protocol-v1-client \
  --filter @pact-network/protocol-evm-v1-client \
  --filter @pact-network/shared \
  --filter @pact-network/wrap \
  --filter @pact-network/classifier

COPY tsconfig.base.json ./
# Build in workspace-dependency order. market-proxy imports @pact-network/shared
# and @pact-network/protocol-evm-v1-client (multi-network adapters); shared
# depends on {protocol-v1-client, protocol-evm-v1-client, wrap} so it builds last
# before market-proxy.
COPY packages/protocol-v1-client packages/protocol-v1-client
RUN pnpm --filter @q3labs/pact-protocol-v1-client build
COPY packages/protocol-evm-v1-client packages/protocol-evm-v1-client
RUN pnpm --filter @pact-network/protocol-evm-v1-client build
# @pact-network/wrap imports @pact-network/classifier (rails-core SLA decision
# tree); build the classifier first so wrap's tsc resolves its dist/.d.ts.
COPY packages/classifier packages/classifier
RUN pnpm --filter @pact-network/classifier build
COPY packages/wrap packages/wrap
RUN pnpm --filter @pact-network/wrap build
COPY packages/shared packages/shared
RUN pnpm --filter @pact-network/shared build
COPY packages/market-proxy packages/market-proxy
RUN pnpm --filter @pact-network/market-proxy build

# -----------------------------------------------------------------------------
# Runtime stage — fresh `pnpm install --prod` instead of copying
# node_modules across stages. Copying /app/node_modules from the builder
# loses pnpm's symlink-to-.pnpm layout and breaks ESM resolution of
# @hono/node-server at runtime.
# -----------------------------------------------------------------------------
FROM node:22-alpine
LABEL service="pact-market-proxy"
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/market-proxy/package.json packages/market-proxy/
COPY packages/protocol-v1-client/package.json packages/protocol-v1-client/
COPY packages/protocol-evm-v1-client/package.json packages/protocol-evm-v1-client/
COPY packages/shared/package.json packages/shared/
COPY packages/wrap/package.json packages/wrap/
COPY packages/classifier/package.json packages/classifier/
RUN pnpm install --frozen-lockfile --prod \
  --filter @pact-network/market-proxy \
  --filter @q3labs/pact-protocol-v1-client \
  --filter @pact-network/protocol-evm-v1-client \
  --filter @pact-network/shared \
  --filter @pact-network/wrap \
  --filter @pact-network/classifier

COPY --from=builder /app/packages/protocol-v1-client/dist packages/protocol-v1-client/dist
COPY --from=builder /app/packages/protocol-evm-v1-client/dist packages/protocol-evm-v1-client/dist
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/wrap/dist packages/wrap/dist
# @pact-network/classifier is runtime code reached via wrap's classifier.
COPY --from=builder /app/packages/classifier/dist packages/classifier/dist
COPY --from=builder /app/packages/market-proxy/dist packages/market-proxy/dist

WORKDIR /app/packages/market-proxy
EXPOSE 8080
CMD ["node", "dist/index.js"]
