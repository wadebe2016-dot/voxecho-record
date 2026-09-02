# CLAUDE.md — VoxEcho Record

Brief de développement. À placer à la racine du dépôt `voxecho-record`.
Claude Code : lis ce document en entier avant tout code. Il fait foi.

## 1. Le produit

VoxEcho Record est un enregistreur d'appels de conformité (réglementation
COBAC, banques/MFI de la zone CEMAC) édité par Atlastech Solution (Douala).
Il capte les conversations dupliquées par la téléphonie du client (Cisco
CUCM Built-in Bridge en priorité), les conserve de façon probante, et les
rend consultables par les personnes habilitées, chaque consultation étant
elle-même tracée. L'acheteur est un responsable conformité ; l'utilisateur
un auditeur, un contrôleur ou un superviseur. La valeur est la **preuve** :
intégrité, traçabilité, rétention — pas le volume de fonctionnalités.

Langue de l'interface : **français**. Fuseau : Africa/Douala.

## 2. Décisions techniques arrêtées (ne pas rediscuter)

- **Backend** : Node.js LTS, **NestJS**, TypeScript strict
- **Base** : PostgreSQL 16, accès par **Prisma** (migrations versionnées)
- **Frontend** : React + Vite + Tailwind, dans le même dépôt
- **Monorepo** : pnpm workspaces — `apps/api`, `apps/web`, `packages/shared`
  (types partagés, dont le contrat d'ingestion)
- **Tests** : unitaires + intégration dès le premier commit (Vitest côté
  web, Jest côté api) ; CI GitHub Actions qui lint + teste + build
- **Livrable** : docker-compose (api, web servi statiquement, postgres) —
  même image cloud (EC2) et on-prem
- **Multi-locataire** dès le premier schéma : colonne `tenant_id` partout,
  cloisonnement vérifié par middleware et par tests
- Pas de secret en dur ; `.env.example` tenu à jour

## 3. Le contrat d'ingestion (la frontière sacrée)

La capture (FreeSWITCH, hors de ce dépôt) et le portail ne communiquent
QUE par ceci. Rien du portail ne doit importer quoi que ce soit de la
capture.

Répertoire surveillé : `INGEST_DIR` (env). Pour chaque appel terminé, le
producteur y dépose **deux fichiers de même radical** :

```
20260901-143012_16778001_1001_699112233.wav      # audio mixé, WAV PCM 8kHz
20260901-143012_16778001_1001_699112233.json     # métadonnées :
{
  "schema": 1,
  "refci": "16778001",          // identifiant d'appel côté PBX
  "near": "1001",               // poste enregistré
  "far": "699112233",           // correspondant
  "direction": "outbound",      // outbound | inbound | internal
  "startedAt": "2026-09-01T14:30:12+01:00",
  "durationSec": 183,
  "source": "cucm-bib"          // cucm-bib | siprec | simulator
}
```

Règles d'ingestion (service `ingestion` de l'api) :
- détection du couple wav+json complet (le json arrive en dernier)
- calcul **SHA-256 du wav à l'ingestion** → stocké en base (preuve
  d'intégrité) ; taille et durée vérifiées
- déplacement vers `STORAGE_DIR/<tenant>/<yyyy>/<mm>/`, nom conservé
- création de l'enregistrement en base, statut `stored`
- json invalide ou wav manquant → répertoire `quarantine/` + événement
  d'audit ; jamais de suppression silencieuse
- idempotent (re-dépôt du même fichier = no-op tracé)

## 4. Le simulateur (à construire au sprint 2, dans `tools/simulator`)

Script TypeScript qui fabrique des appels réalistes sans téléphonie :
- génère des WAV parlés courts (deux tonalités différentes alternées
  suffisent — pas de TTS) de durées variées 15 s à 10 min
- métadonnées plausibles (numéros camerounais 6XXXXXXXX, heures ouvrées,
  mix inbound/outbound), dépôt wav puis json comme le fera FreeSWITCH
- modes : `--one`, `--batch 50`, `--continuous 10/min`, `--corrupt`
  (json malformé, wav tronqué → doit finir en quarantaine)

## 5. Modèle de données (Prisma, point de départ)

- `Tenant` (id, name, createdAt)
- `User` (id, tenantId, email, passwordHash, role: ADMIN | SUPERVISOR |
  AUDITOR, active) — auth JWT, refresh, verrouillage après échecs
- `Recording` (id, tenantId, refci, near, far, direction, startedAt,
  durationSec, filePath, sha256, sizeBytes, source,
  status: stored | archived | purged | hold, createdAt)
- `AuditEvent` (id, tenantId, userId?, action: LOGIN | SEARCH | LISTEN |
  EXPORT | INGEST | QUARANTINE | PURGE | HOLD_SET | HOLD_RELEASE,
  recordingId?, detail jsonb, ip, at) — **append-only** : aucune route
  d'update/delete, et test qui le prouve
- `RetentionPolicy` (id, tenantId, days, appliesTo) + `LegalHold`
  (recordingId, setBy, reason, at) — la purge respecte les holds,
  chaque purge est un AuditEvent

## 6. Portail (apps/web) — V1

- Connexion, bandeau tenant, rôles appliqués côté api ET masqués côté UI
- **Recherche** : par numéro (near/far), plage de dates, direction,
  durée min/max ; pagination serveur ; tri par date
- **Réécoute** : lecteur audio en flux (`Range` supporté), affichage des
  métadonnées et du SHA-256 ; chaque lecture déclenche un AuditEvent
  LISTEN (c'est un argument produit, pas un détail)
- **Export** : wav + fiche PDF/JSON horodatée (métadonnées, sha256,
  demandeur) ; AuditEvent EXPORT
- **Journal d'audit** : consultable par ADMIN/AUDITOR, filtrable, export CSV
- Tableau de bord sobre : volume/jour, durée totale, stockage utilisé,
  dernières quarantaines
- UI sobre et dense, français, pas de dark-pattern démo : ce que voit un
  contrôleur COBAC doit inspirer confiance

## 7. Jalons

- **S1 — Socle** : monorepo, CI, docker-compose dev, auth/rôles/tenants,
  modèle Prisma, seeds. Sortie : login + liste vide + tests verts
- **S2 — Ingestion + simulateur** : contrat §3 implémenté, quarantaine,
  idempotence. Sortie : `--batch 50` → 50 enregistrements en base
- **S3 — Portail** : recherche, réécoute streamée, audit LISTEN.
  Sortie : démo bout-en-bout sur données simulées
- **S4 — Conformité** : rétention, legal hold, purge tracée, export
  horodaté, journal d'audit UI. Sortie : scénario « contrôle COBAC » joué
- **S5 — Branchement réel** : FreeSWITCH du kit labo remplace le
  simulateur (script post-enregistrement qui écrit wav+json au contrat §3).
  AUCUN changement attendu dans apps/ — si un changement est nécessaire,
  c'est un bug du contrat, à corriger dans le contrat

## 8. Règles de travail avec Claude Code

- Petites étapes : une fonctionnalité = une branche = tests = merge
- Jamais deux jalons en parallèle ; finir avant d'ouvrir
- Toute décision d'écart au présent document : la proposer, ne pas
  l'appliquer silencieusement
- Chaque session de travail se termine par : tests verts, lint propre,
  CHANGELOG.md mis à jour de 2-3 lignes en français
- Le chiffrement au repos des fichiers audio (AES-256-GCM par fichier,
  clé maître hors dépôt) est prévu en S4 ; concevoir le stockage pour
  qu'il s'insère sans migration lourde (champ `encrypted` + `keyRef`
  déjà présents dans Recording, nullable)
