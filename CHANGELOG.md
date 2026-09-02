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
- Modèle Prisma complet (§5) avec `tenant_id` partout, colonnes `encrypted` /
  `keyRef` déjà en place pour le chiffrement au repos prévu en S4.
- Journal d'audit append-only garanti **en base** par déclencheur SQL
  (UPDATE, DELETE et TRUNCATE refusés) ; suppression d'un locataire, d'un
  compte ou d'un enregistrement tracé refusée (`onDelete: Restrict`).
- Mots de passe en Argon2id, `docker compose up -d db`, seed de deux
  locataires pour rendre le cloisonnement visible dès le premier lancement.
- Authentification JWT : connexion, rafraîchissement avec rotation et
  révocation, déconnexion, `/api/auth/me`. Verrouillage du compte après cinq
  échecs, réponse identique pour une adresse inconnue et un mot de passe
  erroné, connexions tracées au journal d'audit.
- Gardes globaux : toute route est authentifiée sauf `@Public()`, les rôles
  sont appliqués côté api, et toute tentative de désigner un autre locataire
  que celui du jeton est refusée.
