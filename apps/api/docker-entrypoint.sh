#!/bin/sh
# Applique les migrations avant de démarrer : le schéma d'une base de
# conformité ne doit jamais être en retard sur le code qui écrit dedans.
# `prisma` est une dépendance d'exécution pour cette raison — la CLI doit
# survivre au `pnpm prune --prod` de la construction.
set -e

# L'URL de connexion, si elle n'a pas été fournie entière. Elle est construite
# par le produit lui-même plutôt que concaténée dans un compose : un mot de
# passe tiré au hasard contient tôt ou tard un `/` ou un `+`, et une URL
# assemblée sans encodage se termine en « invalid port number » (CLAUDE.md
# §9.19).
if [ -z "${DATABASE_URL:-}" ]; then
  DATABASE_URL=$(node /app/apps/api/dist/config/database-url.js)
  export DATABASE_URL
fi

echo "Application des migrations Prisma…"
cd /app/apps/api
./node_modules/.bin/prisma migrate deploy
cd /app

exec "$@"
