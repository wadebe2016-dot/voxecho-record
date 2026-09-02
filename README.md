# VoxEcho Record

Enregistreur d'appels de conformité (COBAC, zone CEMAC) — Atlastech Solution, Douala.

Il capte les conversations dupliquées par la téléphonie du client (Cisco CUCM
Built-in Bridge en priorité), les conserve de façon probante (SHA-256 à
l'ingestion, rétention, legal hold) et les rend consultables par les personnes
habilitées, chaque consultation étant elle-même tracée.

Interface en **français**, fuseau **Africa/Douala**.

## Structure

```
apps/api        API NestJS + Prisma (PostgreSQL 16)
apps/web        Portail React + Vite + Tailwind
packages/shared Types partagés, dont le contrat d'ingestion
tools/simulator Générateur d'appels simulés (sprint 2)
```

## Prérequis

- Node.js 22 LTS
- pnpm 9 (`corepack enable`)
- Docker + Docker Compose (PostgreSQL de développement)

## Démarrage

```bash
cp .env.example .env      # puis renseigner les secrets
pnpm install
docker compose up -d db   # PostgreSQL 16
pnpm --filter @voxecho/api prisma:migrate
pnpm --filter @voxecho/api seed
pnpm dev                  # api sur :3000, portail sur :5173
```

## Commandes

| Commande      | Effet                                   |
| ------------- | --------------------------------------- |
| `pnpm lint`   | ESLint sur tous les paquets             |
| `pnpm test`   | Tests unitaires et d'intégration        |
| `pnpm build`  | Build de production de tous les paquets |
| `pnpm format` | Formatage Prettier                      |

## Documentation

- `CLAUDE.md` — brief produit et décisions techniques (fait foi)
- `CHANGELOG.md` — journal des évolutions
