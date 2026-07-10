# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY dashboard/package.json dashboard/package-lock.json ./dashboard/
COPY scripts ./scripts
RUN npm ci \
  && npm ci --prefix dashboard

COPY tsconfig.json ./
COPY src ./src
COPY dashboard ./dashboard
COPY docs ./docs
RUN npm run build

FROM node:24-bookworm-slim AS runner

ARG POLYMIRROR_GIT_SHA
LABEL org.opencontainers.image.revision=$POLYMIRROR_GIT_SHA

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY scripts ./scripts
COPY config/candidate-cohort.schema.json ./config/candidate-cohort.schema.json
RUN npm ci --omit=dev \
  && npm cache clean --force

COPY --from=builder /app/dist ./dist

RUN mkdir -p data

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
