# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    APP_TIME_ZONE=Asia/Shanghai \
    PORT=3000

WORKDIR /app

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates tini tzdata \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY server.js db.js ./
COPY middleware ./middleware
COPY public ./public
COPY routes ./routes
COPY services ./services
COPY templates ./templates
COPY views ./views

RUN mkdir -p /app/data/exports

EXPOSE 3000
VOLUME ["/app/data"]

ENTRYPOINT ["tini", "--"]
CMD ["node", "server.js"]
