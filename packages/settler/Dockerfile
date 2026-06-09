FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

# Copy workspace manifests
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/settler/package.json packages/settler/
COPY packages/protocol-v1-client/package.json packages/protocol-v1-client/
COPY packages/protocol-evm-v1-client/package.json packages/protocol-evm-v1-client/
COPY packages/shared/package.json packages/shared/
COPY packages/wrap/package.json packages/wrap/
COPY packages/classifier/package.json packages/classifier/

# Install all workspace deps for settler + its workspace deps
RUN pnpm install --frozen-lockfile \
  --filter @pact-network/settler \
  --filter @q3labs/pact-protocol-v1-client \
  --filter @pact-network/protocol-evm-v1-client \
  --filter @pact-network/shared \
  --filter @pact-network/wrap \
  --filter @pact-network/classifier

# tsconfig.base.json — required because packages/wrap/tsconfig.json
# extends ../../tsconfig.base.json (without it, tsc falls back to ES5 lib
# and BigInt/Promise/padStart references fail to compile).
COPY tsconfig.base.json ./

# Build in workspace-dependency order: protocol-v1-client and
# protocol-evm-v1-client have no workspace deps; @pact-network/shared depends
# on all of {protocol-v1-client, protocol-evm-v1-client, wrap} and so must be
# built last before settler. settler imports @pact-network/shared and
# @pact-network/protocol-evm-v1-client (multi-network adapters), so both dists
# must exist before `tsc` runs for settler.
# @pact-network/wrap imports @pact-network/classifier (rails-core SLA decision
# tree); build the classifier first so wrap's tsc resolves its dist/.d.ts.
COPY packages/protocol-v1-client packages/protocol-v1-client
RUN pnpm --filter @q3labs/pact-protocol-v1-client build

COPY packages/protocol-evm-v1-client packages/protocol-evm-v1-client
RUN pnpm --filter @pact-network/protocol-evm-v1-client build

COPY packages/classifier packages/classifier
RUN pnpm --filter @pact-network/classifier build

COPY packages/wrap packages/wrap
RUN pnpm --filter @pact-network/wrap build

COPY packages/shared packages/shared
RUN pnpm --filter @pact-network/shared build

COPY packages/settler packages/settler
RUN pnpm --filter @pact-network/settler build

# -----------------------------------------------------------------------------
# Runtime stage — fresh `pnpm install --prod` mirrors the indexer pattern.
# Copying node_modules across stages with pnpm's symlink layout was unreliable
# (broken @nestjs/core resolution at runtime); installing prod-only here is
# deterministic and works.
# -----------------------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/settler/package.json packages/settler/
COPY packages/protocol-v1-client/package.json packages/protocol-v1-client/
COPY packages/protocol-evm-v1-client/package.json packages/protocol-evm-v1-client/
COPY packages/shared/package.json packages/shared/
COPY packages/wrap/package.json packages/wrap/
COPY packages/classifier/package.json packages/classifier/
RUN pnpm install --frozen-lockfile --prod \
  --filter @pact-network/settler \
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
COPY --from=builder /app/packages/settler/dist packages/settler/dist

WORKDIR /app/packages/settler
EXPOSE 8080
CMD ["node", "dist/main"]
