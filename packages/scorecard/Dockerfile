FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json tsconfig.json vite.config.ts tailwind.config.ts postcss.config.js index.html ./
COPY src ./src
RUN npm install && npm run build

FROM caddy:2-alpine
COPY --from=builder /app/dist /srv/scorecard
