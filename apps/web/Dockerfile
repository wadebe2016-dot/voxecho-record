# syntax=docker/dockerfile:1

# ─── Construction ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @voxecho/web... --filter @voxecho/shared...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web

# Le portail est servi sur la même origine que l'api (nginx relaie /api) :
# aucune URL d'api à figer à la construction, donc aucune image par client.
ENV VITE_API_URL=""
RUN pnpm --filter @voxecho/shared build && pnpm --filter @voxecho/web build

# ─── Exécution ─────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS runtime
ENV TZ=Africa/Douala
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
