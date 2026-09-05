#!/usr/bin/env bash
#
# Éprouve les migrations Prisma sur une base **peuplée** — CLAUDE.md §9.30.
#
# Une migration qui passe sur une base vide ne prouve rien : c'est exactement
# ainsi que `case_reference NOT NULL` sans défaut est passée en revue, alors
# qu'elle aurait refusé de s'appliquer sur une base contenant déjà des
# conservations forcées — et que l'api aurait refusé de démarrer chez le
# client, au pire moment.
#
# Deux modes :
#
#   --dump <fichier>   restaure un dump réel (celui de l'instance en service)
#                      puis applique les migrations en attente ;
#
#   sans dump          rejoue toutes les migrations sauf les dernières, peuple
#                      la base avec un jeu représentatif, puis applique ce qui
#                      restait. Reproduit le cas « table non vide » sans accès
#                      à l'instance.
#
# Pour produire le dump de l'instance :
#   docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env \
#     exec -T db pg_dump -U voxecho -Fc voxecho > demo.dump

set -euo pipefail

readonly PROGRAMME="${0##*/}"
RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly RACINE
readonly BASE_ESSAI="${MIGRATE_CHECK_DB:-voxecho_migrate_check}"

dump=""
garder=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dump) dump="${2:-}"; shift 2 ;;
    --garder) garder=1; shift ;;
    -h|--help)
      sed -n '3,25p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "$PROGRAMME : option inconnue : $1" >&2; exit 2 ;;
  esac
done

# Le .env est propre à chaque poste et n'est pas versionné : shellcheck ne
# peut pas le suivre, et n'a pas à essayer.
set -a
# shellcheck disable=SC1091
. "$RACINE/.env"
set +a

if [ -z "${DATABASE_URL:-}" ]; then
  echo "$PROGRAMME : DATABASE_URL absente (voir .env.example)." >&2
  exit 1
fi

# Serveur visé, sans le nom de base ni les paramètres de Prisma.
serveur=$(node -e '
  const u = new URL(process.argv[1]);
  u.pathname = "/postgres";
  u.search = "";
  process.stdout.write(u.toString());
' "$DATABASE_URL")

url_essai=$(node -e '
  const u = new URL(process.argv[1]);
  u.pathname = "/" + process.argv[2];
  u.search = "?schema=public";
  process.stdout.write(u.toString());
' "$DATABASE_URL" "$BASE_ESSAI")

nettoyer() {
  if [ "$garder" -eq 0 ]; then
    psql "$serveur" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $BASE_ESSAI" >/dev/null 2>&1 || true
  fi
}
trap nettoyer EXIT

echo "== Base d'essai : $BASE_ESSAI"
psql "$serveur" -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $BASE_ESSAI"
psql "$serveur" -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $BASE_ESSAI"

cd "$RACINE/apps/api"

if [ -n "$dump" ]; then
  [ -f "$dump" ] || { echo "$PROGRAMME : dump introuvable : $dump" >&2; exit 1; }
  echo "== Restauration de $dump"
  # `--no-owner` : le dump vient d'une machine dont les rôles ne sont pas ici.
  pg_restore --dbname "$serveur" --no-owner --no-privileges --clean --if-exists \
    --dbname "$url_essai" "$dump" >/dev/null
else
  echo "== Pas de dump : on fabrique une base peuplée"
  # Toutes les migrations sauf la dernière, pour peupler avant de l'appliquer.
  # Les dernières migrations, par ordre de nom — elles sont horodatées, donc
  # l'ordre alphabétique est l'ordre chronologique.
  dernieres=$(
    for repertoire in prisma/migrations/*/; do
      basename "$repertoire"
    done | sort | tail -n "${MIGRATE_CHECK_RETENUES:-1}"
  )
  mkdir -p /tmp/migrate-check-retirees
  for migration in $dernieres; do
    mv "prisma/migrations/$migration" "/tmp/migrate-check-retirees/$migration"
  done
  restaurer_migrations() {
    for migration in $dernieres; do
      [ -d "/tmp/migrate-check-retirees/$migration" ] &&
        mv "/tmp/migrate-check-retirees/$migration" "prisma/migrations/$migration"
    done
  }
  trap 'restaurer_migrations; nettoyer' EXIT

  DATABASE_URL="$url_essai" ./node_modules/.bin/prisma migrate deploy >/dev/null
  echo "== Jeu de données représentatif"
  DATABASE_URL="$url_essai" node ../../scripts/peupler-base-essai.mjs
  restaurer_migrations
  echo "== Migrations retenues : $(echo "$dernieres" | tr '\n' ' ')"
fi

echo "== Application des migrations en attente"
if DATABASE_URL="$url_essai" ./node_modules/.bin/prisma migrate deploy; then
  echo
  echo "$PROGRAMME : migrations appliquées sur une base peuplée."
else
  echo
  echo "$PROGRAMME : ÉCHEC — cette migration ne passerait pas sur une base en service." >&2
  exit 1
fi
