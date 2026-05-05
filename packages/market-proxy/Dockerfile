FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/market-proxy/package.json packages/market-proxy/
COPY packages/wrap/package.json packages/wrap/
RUN pnpm install --frozen-lockfile --filter @pact-network/market-proxy --filter @pact-network/wrap
COPY tsconfig.base.json ./
COPY packages/wrap packages/wrap
COPY packages/market-proxy packages/market-proxy
RUN pnpm --filter @pact-network/wrap build && pnpm --filter @pact-network/market-proxy build

FROM node:22-alpine
LABEL service="pact-market-proxy"
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/wrap/dist ./packages/wrap/dist
COPY --from=builder /app/packages/wrap/package.json ./packages/wrap/package.json
COPY --from=builder /app/packages/market-proxy/dist ./packages/market-proxy/dist
COPY --from=builder /app/packages/market-proxy/package.json ./packages/market-proxy/package.json
WORKDIR /app/packages/market-proxy
EXPOSE 8080
CMD ["node", "dist/index.js"]
