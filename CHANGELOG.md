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
- `GET /api/recordings` : liste paginée et triée côté serveur, restreinte au
  locataire du jeton, chaque consultation tracée (`SEARCH`). Types de
  réponse partagés avec le portail dans `packages/shared`.
- `apps/web` : portail React + Vite + Tailwind — connexion, bandeau
  locataire, navigation masquée par rôle, liste des enregistrements dense
  avec empreinte SHA-256, heures affichées en Africa/Douala. Jetons en
  `sessionStorage` : la session ne survit pas à la fermeture de l'onglet.
- Livrable docker-compose : api, portail servi par nginx (même origine, donc
  pas de CORS), PostgreSQL. L'api applique les migrations à son démarrage.
- CI GitHub Actions : formatage, lint, types, migrations, 144 tests,
  construction des paquets et des deux images.
- CLAUDE.md §9 « Décisions actées » : l'unicité globale de l'adresse e-mail
  est assumée (une instance par client) et documentée avec sa réserve —
  bascule vers `@@unique([tenantId, email])` si une offre mutualisée arrive.

Sortie de jalon S1 atteinte : connexion, liste vide et tests verts.

### S2 — Ingestion

- Contrat §3 amendé : le locataire d'un dépôt se lit dans l'arborescence,
  `INGEST_DIR/<slug>/`. Le json et la version de schéma ne changent pas ;
  décision et réserve consignées en §9.2 de `CLAUDE.md`.
- Service `ingestion` : balayage périodique d'`INGEST_DIR`, détection de la
  paire wav+json, contrôle du nom, des métadonnées, de l'en-tête WAV, de la
  taille et de la durée, SHA-256 calculé en flux, rangement sous
  `STORAGE_DIR/<tenantId>/<yyyy>/<mm>/` et trace `INGEST`.
- Quarantaine systématique et tracée : json malformé ou hors contrat, wav
  tronqué ou de durée démentie, nom en désaccord avec les métadonnées, json
  orphelin, extension étrangère, dépôt visant un locataire inconnu ou
  désactivé. L'ingestion ne crée jamais de locataire implicitement.
- Idempotence : un re-dépôt identique est retiré et tracé ; un re-dépôt de
  même nom mais d'empreinte différente est un conflit mis en quarantaine, la
  preuve déjà rangée n'est jamais écrasée.
- `Tenant.slug` et `Tenant.active` ajoutés ; `AuditEvent.tenantId` devient
  nullable pour les seuls dépôts qu'aucun locataire ne réclame.
- Lecture et fabrication d'en-têtes WAV PCM dans `packages/shared`, partagées
  avec le simulateur à venir — 185 tests.
