# syntax=docker/dockerfile:1
FROM node:22-alpine AS deps
WORKDIR /web
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM node:22-alpine AS builder
WORKDIR /web
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /web/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /web
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

COPY --from=builder /web/package.json ./package.json
COPY --from=builder /web/next.config.ts ./next.config.ts
COPY --from=builder /web/public ./public
COPY --from=builder /web/.next ./.next
COPY --from=deps /web/node_modules ./node_modules

RUN chown -R node:node /web
USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/login >/dev/null || exit 1

CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3001", "-H", "0.0.0.0"]
