#!/bin/sh
# Applique les migrations avant de démarrer : le schéma d'une base de
# conformité ne doit jamais être en retard sur le code qui écrit dedans.
# `prisma` est une dépendance d'exécution pour cette raison — la CLI doit
# survivre au `pnpm prune --prod` de la construction.
set -e

echo "Application des migrations Prisma…"
cd /app/apps/api
./node_modules/.bin/prisma migrate deploy
cd /app

exec "$@"
