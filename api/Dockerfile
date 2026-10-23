# Multi-stage build for the AdonisJS 6 admin console API (same shape as the tutor API's).

FROM node:22-slim AS base
# IST: the shared database stores local wall-clock times, and the audit hash chain reads
# timestamps back in the process time zone, so every console process must run in IST.
ENV TZ=Asia/Kolkata

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules /app/node_modules
COPY . .
RUN node ace build

FROM base
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-deps /app/node_modules /app/node_modules
COPY --from=build /app/build /app
EXPOSE 3500
USER node
# All settings and secrets come from the env_file at runtime (deploy/docker-compose.yml).
# Migrations: docker compose run --rm admin-api node ace migration:run --force
CMD ["node", "bin/server.js"]
