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

## Démarrage en développement

```bash
cp .env.example .env      # puis remplacer les deux secrets JWT
pnpm install
docker compose up -d db   # PostgreSQL 16 seul
pnpm --filter @voxecho/api prisma:migrate
pnpm --filter @voxecho/api seed
pnpm dev                  # api sur :3000, portail sur :5173
```

Générer un secret : `openssl rand -base64 48`. L'api refuse de démarrer si un
secret est resté à sa valeur d'exemple, est trop court, ou si les deux secrets
sont identiques.

Comptes du jeu d'essai, mot de passe `Demo!2026` :

| Compte                | Rôle           | Locataire                     |
| --------------------- | -------------- | ----------------------------- |
| `admin@demo.cm`       | Administrateur | Banque de démonstration CEMAC |
| `superviseur@demo.cm` | Superviseur    | Banque de démonstration CEMAC |
| `auditeur@demo.cm`    | Auditeur       | Banque de démonstration CEMAC |
| `admin@temoin.cm`     | Administrateur | Microfinance Témoin           |

Le second locataire n'existe que pour rendre le cloisonnement visible :
connecté à l'un, on ne voit jamais les enregistrements de l'autre.

## Livraison

```bash
docker compose up -d --build   # portail sur :8080, api relayée par nginx
```

Même composition en nuage (EC2) et sur site. Le portail et l'api partagent
l'origine — nginx relaie `/api` — donc pas de CORS et aucun jeton qui traverse
un domaine tiers. L'api applique les migrations à son démarrage.

## Commandes

| Commande            | Effet                                   |
| ------------------- | --------------------------------------- |
| `pnpm lint`         | ESLint sur tous les paquets             |
| `pnpm test`         | Tests unitaires et d'intégration        |
| `pnpm -r typecheck` | Vérification des types                  |
| `pnpm build`        | Build de production de tous les paquets |
| `pnpm format`       | Formatage Prettier                      |

Exploitation (dans `apps/api`, via `pnpm --filter @voxecho/api run …`) :

| Commande                 | Effet                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| `storage:sceller`        | Scelle les pièces déjà rangées en clair (simulation par défaut)    |
| `sauvegarde:creer`       | Dump de la base + inventaire du stockage + manifeste (§9.14)       |
| `sauvegarde:verifier`    | Vérifie une prise ; `--stockage` recalcule chaque empreinte        |
| `restauration:constater` | Confronte la base restaurée au manifeste et à l'inventaire (§9.15) |

La sauvegarde ne recopie pas les fichiers audio : ils se sauvegardent par les
moyens de l'exploitant, et `sauvegarde:verifier --stockage` prouve que la copie
est complète et intacte. La clé maître n'y est jamais écrite — seule son
empreinte l'est, pour reconnaître la bonne clé le jour d'une restauration.

Les tests d'intégration de l'api travaillent dans le schéma PostgreSQL `test`
de la même base : ils ne touchent jamais aux données de développement.

## Ce qui est en place (S1)

- Multi-locataire : `tenant_id` sur toutes les tables, cloisonnement appliqué
  par un garde global et vérifié par les tests
- Authentification JWT avec rafraîchissement tournant, révocation et
  verrouillage du compte après échecs répétés
- Journal d'audit **append-only**, garanti par déclencheur PostgreSQL :
  `UPDATE`, `DELETE` et `TRUNCATE` sont refusés, y compris en SQL direct
- Connexions et consultations tracées

## Ce qui est en place (S2)

L'ingestion du contrat §3 est implémentée. La capture dépose la paire
wav + json dans le sous-répertoire du locataire :

```
INGEST_DIR/<slug>/20260901-143012_16778001_1001_699112233.wav
INGEST_DIR/<slug>/20260901-143012_16778001_1001_699112233.json
```

L'api balaie `INGEST_DIR` toutes les `INGEST_POLL_MS` millisecondes et, pour
chaque paire complète : vérifie le nom, les métadonnées, l'en-tête WAV, la
taille et la durée, calcule le SHA-256, range l'audio sous
`STORAGE_DIR/<tenantId>/<yyyy>/<mm>/` et crée l'enregistrement en base.

Tout ce qui ne passe pas ces contrôles part en `QUARANTINE_DIR` avec un
événement d'audit — un dépôt visant un locataire inconnu ou désactivé
compris, car l'ingestion ne crée jamais de locataire. Rien n'est jamais
supprimé silencieusement, et un re-dépôt identique est un no-op tracé.

### Le simulateur

`tools/simulator` fabrique des appels réalistes sans téléphonie : numéros
camerounais, heures ouvrées, durées de 15 s à 10 min, audio en deux
tonalités alternées qui imitent le tour de parole. Il n'écrit que des
fichiers — aucune connexion à la base, aucun appel à l'api — pour qu'en S5
le remplacer par FreeSWITCH ne change rien au portail.

```bash
pnpm --filter @voxecho/simulator simulate -- --batch 50
pnpm --filter @voxecho/simulator simulate -- --continuous 10/min --tenant banque-cemac,mfi-b
pnpm --filter @voxecho/simulator simulate -- --one --corrupt   # doit finir en quarantaine
pnpm --filter @voxecho/simulator simulate -- --help
```

`--seed <n>` rejoue une démonstration à l'identique ; `--spread-days <n>`
étale le lot sur plusieurs jours pour peupler le tableau de bord.

## Ce qui est en place (S3 et S4)

- **Portail** : recherche (numéro, dates, sens, durée, catégorie d'opération),
  fiche d'appel, réécoute en flux avec `Range`, export horodaté, journal
  d'audit et tableau de bord — en français, heures d'Africa/Douala
- **Habilitations** : entendre une conversation de client n'est pas un droit
  d'exploitation. Réécoute, export et journal sont réservés à `AUDITOR` et
  `ADMIN` ; le `SUPERVISOR` garde la recherche, les métadonnées, l'empreinte et
  le tableau de bord (§9.9, §9.11, §9.12)
- **Conservation** : politique par locataire (730 jours par défaut), dérogation
  motivée sous le plancher, conservation forcée qui prime toujours sur
  l'échéance, purge autorisée sur rapport figé et jamais automatique
- **Preuve** : empreinte relevée à l'ingestion, recalculée et confrontée à
  chaque export, chiffrement au repos par trames de 64 Kio, sauvegarde
  vérifiable et constat d'après-restauration

Le scénario de contrôle qui les met bout à bout — `apps/api/test/controle-cobac.spec.ts`
— se rejoue à chaque CI : la téléphonie dépose, le portail range et scelle, un
contrôleur interroge le périmètre, l'intégrité, les habilitations, les
destructions, le journal, puis la capacité à restaurer.

## Durcissement

- L'adresse du demandeur n'est lue dans `X-Forwarded-For` que si le relais est
  déclaré dans `TRUSTED_PROXIES` (vide par défaut). En livraison, le
  docker-compose déclare le réseau du nginx.
- Les tentatives de connexion sont limitées par adresse (`AUTH_RATE_MAX` échecs
  par `AUTH_RATE_WINDOW_SEC`), en plus du verrouillage de compte. Le blocage est
  inscrit au journal d'audit une fois par épisode.
- `API_BEHIND_TLS=true` dès qu'une terminaison TLS est en place : c'est ce qui
  autorise l'api à émettre HSTS.

## Documentation

- `CLAUDE.md` — brief produit et décisions techniques (fait foi)
- `CHANGELOG.md` — journal des évolutions
