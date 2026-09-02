# syntax=docker/dockerfile:1

# ─── Construction ──────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @voxecho/api... --filter @voxecho/shared...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api

RUN pnpm --filter @voxecho/shared build \
  && pnpm --filter @voxecho/api exec prisma generate \
  && pnpm --filter @voxecho/api build

# Dépendances de production uniquement, client Prisma compris.
RUN pnpm prune --prod \
  && pnpm --filter @voxecho/api exec prisma generate

# ─── Exécution ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV TZ=Africa/Douala
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends tini curl openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# La CLI Prisma vérifie ses moteurs au démarrage et doit pouvoir écrire dans
# node_modules : l'arborescence appartient donc au compte non privilégié.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/
COPY --from=build --chown=node:node /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/
COPY --from=build --chown=node:node /app/apps/api/prisma ./apps/api/prisma
COPY apps/api/docker-entrypoint.sh /usr/local/bin/

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /data/ingest /data/storage /data/quarantine \
  && chown -R node:node /data

USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "apps/api/dist/main.js"]
