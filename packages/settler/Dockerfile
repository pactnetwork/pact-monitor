FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

# Copy workspace manifests
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/settler/package.json packages/settler/
COPY packages/protocol-v1-client/package.json packages/protocol-v1-client/
COPY packages/wrap/package.json packages/wrap/

# Install all workspace deps for settler + its workspace deps
RUN pnpm install --frozen-lockfile \
  --filter @pact-network/settler \
  --filter @pact-network/protocol-v1-client \
  --filter @pact-network/wrap

# Build protocol-v1-client first (settler depends on it), then wrap, then settler
COPY packages/protocol-v1-client packages/protocol-v1-client
RUN pnpm --filter @pact-network/protocol-v1-client build

COPY packages/wrap packages/wrap
RUN pnpm --filter @pact-network/wrap build

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
COPY packages/wrap/package.json packages/wrap/
RUN pnpm install --frozen-lockfile --prod \
  --filter @pact-network/settler \
  --filter @pact-network/protocol-v1-client \
  --filter @pact-network/wrap

COPY --from=builder /app/packages/protocol-v1-client/dist packages/protocol-v1-client/dist
COPY --from=builder /app/packages/wrap/dist packages/wrap/dist
COPY --from=builder /app/packages/settler/dist packages/settler/dist

WORKDIR /app/packages/settler
EXPOSE 8080
CMD ["node", "dist/main"]
