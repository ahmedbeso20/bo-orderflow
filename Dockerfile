# syntax=docker/dockerfile:1
FROM node:22-alpine AS base
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data

# Copy manifests first for layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY server.js index.html metadata.json ./
COPY src ./src
COPY public ./public

# Persistent SQLite & uploads volume with non-root permissions
RUN mkdir -p /app/data/uploads /app/data/backups \
  && chown -R node:node /app

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
