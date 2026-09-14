FROM node:22-alpine AS builder
WORKDIR /build
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /build/node_modules ./node_modules
COPY package.json ./
COPY shared/ ./shared/
COPY server/ ./server/
COPY public/ ./public/
RUN adduser -D -u 1001 appuser && mkdir -p /data && chown 1001:1001 /data
USER 1001
ENV DB_PATH=/data/skrytka.db
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -q --spider http://localhost:3000/healthz || exit 1
CMD ["node", "server/index.js"]
