FROM node:22-alpine AS base
ENV PNPM_HOME=/usr/local/bin
RUN npm install -g pnpm@10

# Build stage — needs full monorepo context for workspace deps
FROM base AS builder
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/settler/package.json ./packages/settler/
COPY packages/market-client/package.json ./packages/market-client/
RUN pnpm install --frozen-lockfile --filter @pact-network/settler --filter @pact-network/market-client

COPY packages/market-client ./packages/market-client
RUN pnpm --filter @pact-network/market-client build

COPY packages/settler ./packages/settler
RUN pnpm --filter @pact-network/settler build

# Runtime stage
FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=builder /app/packages/settler/dist ./dist
COPY --from=builder /app/packages/settler/node_modules ./node_modules
COPY --from=builder /app/packages/settler/package.json ./package.json
EXPOSE 8080
CMD ["node", "dist/main"]
