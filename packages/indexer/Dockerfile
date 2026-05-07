FROM node:22-alpine AS builder
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace manifests
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/db/package.json ./packages/db/
COPY packages/indexer/package.json ./packages/indexer/

# Install all workspace deps (frozen)
RUN pnpm install --frozen-lockfile

# Copy sources (tsconfig.base.json is required because packages/db/tsconfig.json
# extends ../../tsconfig.base.json — without it, tsc falls back to ES5 lib and
# Prisma's generated types reference BigInt/Symbol/Map fail to compile)
COPY tsconfig.base.json ./
COPY packages/db/ ./packages/db/
COPY packages/indexer/ ./packages/indexer/

# Generate Prisma client + build db, then build indexer
RUN pnpm --filter @pact-network/db build
RUN pnpm --filter @pact-network/indexer build

FROM node:22-alpine
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/db/package.json ./packages/db/
COPY packages/indexer/package.json ./packages/indexer/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/indexer/dist ./packages/indexer/dist
# Prisma engine for runtime
COPY --from=builder /app/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/.prisma ./node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/.prisma

EXPOSE 3001
ENV NODE_ENV=production
CMD ["node", "packages/indexer/dist/main.js"]
