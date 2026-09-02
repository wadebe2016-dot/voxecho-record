# Journal des évolutions

Format : une entrée par session de travail, en français.

## Non publié

### S1 — Socle

- Mise en place du monorepo pnpm (`apps/`, `packages/`, `tools/`), TypeScript
  strict partagé, Prettier, ESLint et `.env.example`.
- `packages/shared` : contrat d'ingestion (§3) exprimé en Zod, nommage des
  fichiers déposés, énumérations du domaine — 39 tests.
- `apps/api` : socle NestJS, configuration d'environnement validée au
  démarrage (secrets d'exemple refusés), sonde `/api/health`.
