FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/proxy/package.json packages/proxy/
RUN pnpm install --frozen-lockfile --filter @pact-network/proxy
COPY tsconfig.base.json ./
COPY packages/proxy packages/proxy
RUN pnpm --filter @pact-network/proxy build

FROM node:22-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/proxy/dist ./packages/proxy/dist
COPY --from=builder /app/packages/proxy/package.json ./packages/proxy/package.json
WORKDIR /app/packages/proxy
EXPOSE 8080
CMD ["node", "dist/index.js"]
