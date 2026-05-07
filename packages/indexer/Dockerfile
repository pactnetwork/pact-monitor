FROM node:22-slim AS builder
WORKDIR /app

# Prisma needs `openssl` (binary, for version detection) + libssl3 in BOTH stages.
# Without it, Prisma defaults to the `debian-openssl-1.1.x` engine, which
# libssl3-only Debian 12 (slim) cannot load. ca-certificates needed for
# Prisma's optional unpkg.com fetch during engine selection.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace manifests
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/db/package.json ./packages/db/
COPY packages/protocol-v1-client/package.json ./packages/protocol-v1-client/
COPY packages/indexer/package.json ./packages/indexer/

# Install all workspace deps (frozen)
RUN pnpm install --frozen-lockfile

# Copy sources (tsconfig.base.json is required because packages/db/tsconfig.json
# extends ../../tsconfig.base.json — without it, tsc falls back to ES5 lib and
# Prisma's generated types reference BigInt/Symbol/Map fail to compile)
COPY tsconfig.base.json ./
COPY packages/db/ ./packages/db/
COPY packages/protocol-v1-client/ ./packages/protocol-v1-client/
COPY packages/indexer/ ./packages/indexer/

# Generate Prisma client + build db + build protocol-v1-client (chain-sync
# imports from its dist/), then build indexer.
RUN pnpm --filter @pact-network/db build
RUN pnpm --filter @pact-network/protocol-v1-client build
RUN pnpm --filter @pact-network/indexer build

FROM node:22-slim
WORKDIR /app

# Same openssl install as the builder stage — runtime needs the libssl3 +
# openssl binary for Prisma's engine to load successfully.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/db/package.json ./packages/db/
COPY packages/protocol-v1-client/package.json ./packages/protocol-v1-client/
COPY packages/indexer/package.json ./packages/indexer/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/protocol-v1-client/dist ./packages/protocol-v1-client/dist
COPY --from=builder /app/packages/indexer/dist ./packages/indexer/dist
# Prisma engine for runtime
COPY --from=builder /app/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/.prisma ./node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/.prisma

EXPOSE 3001
ENV NODE_ENV=production
CMD ["node", "packages/indexer/dist/main.js"]
