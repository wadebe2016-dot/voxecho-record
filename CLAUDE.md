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

Répertoire surveillé : `INGEST_DIR` (env). Le json ne porte pas le
locataire : c'est **l'arborescence qui le désigne**. Le producteur dépose
dans le sous-répertoire du locataire qu'il alimente, nommé d'après le
`slug` du locataire (minuscules, chiffres, tirets) :

```
INGEST_DIR/<slug>/<radical>.wav
INGEST_DIR/<slug>/<radical>.json
```

Pour chaque appel terminé, le producteur y dépose **deux fichiers de même
radical** :

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
- **un dépôt dans un sous-répertoire ne correspondant à aucun locataire
  actif part en quarantaine avec un AuditEvent `QUARANTINE`.** L'ingestion
  ne crée **jamais** de locataire implicitement : un locataire naît d'un
  acte d'administration, jamais d'un répertoire apparu sur un disque.
  Idem pour un locataire désactivé (`Tenant.active = false`) et pour un
  fichier déposé à la racine d'`INGEST_DIR`. Ces événements sont les seuls
  du journal dont le `tenantId` est nul : il n'y a précisément personne à
  qui les attribuer, et ils ne sont lisibles que par un ADMIN de l'instance
- idempotent (re-dépôt du même fichier = no-op tracé) ; un fichier redéposé
  sous le même nom mais de **SHA-256 différent** n'est pas un doublon, c'est
  un conflit : quarantaine, jamais d'écrasement de la preuve déjà rangée

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

## 9. Décisions actées

Écarts et choix d'implémentation retenus en cours de route, avec leur
réserve. Une entrée par décision ; ce qui est acté ici ne se rediscute
pas sans raison nouvelle, mais la réserve dit à quelle condition rouvrir.

### 9.1 Adresse e-mail unique globalement (S1)

`User.email` porte une contrainte d'unicité **globale**, pas par
locataire (`@unique` et non `@@unique([tenantId, email])`). Une même
adresse ne peut donc pas ouvrir de compte chez deux locataires. C'est
volontaire et testé (`apps/api/test/model.spec.ts`, « refuse deux
comptes avec la même adresse, même sur des locataires différents ») :
la connexion se fait par adresse seule, sans choix préalable de
locataire — pas de sélecteur, pas d'adresse ambiguë au moment de
l'authentification, donc pas de doute sur l'identité au journal d'audit.

Le modèle de déploiement le permet : une instance par client, en nuage
ou sur site, le multi-locataire servant au cloisonnement interne
(filiales, réseaux de MFI) et aux jeux de démonstration.

**Réserve** — si une offre mutualisée voit le jour (plusieurs clients
sur une même instance, un auditeur externe intervenant pour deux
banques), il faut basculer vers l'unicité par locataire :

- migration Prisma : remplacer `@unique` par `@@unique([tenantId, email])`
- la connexion devient une résolution en deux temps (locataire puis
  identifiants) — sous-domaine, code client ou sélection explicite ;
  jamais un choix implicite fait par l'api
- les tests de cloisonnement existants restent la référence : ils doivent
  passer sans être assouplis, et un cas « même adresse, deux locataires,
  deux sessions distinctes » vient s'y ajouter

Tant que ce besoin n'est pas exprimé, on ne paie pas cette complexité.

### 9.2 Le locataire se lit dans l'arborescence (S2)

Le contrat §3 décrivait un `INGEST_DIR` plat alors que `Recording.tenantId`
est obligatoire et que le stockage est rangé par locataire : rien ne disait
à qui appartenait un fichier déposé. Le contrat est amendé plutôt que
contourné — c'est le cas prévu au §7, S5 (« si un changement est
nécessaire, c'est un bug du contrat, à corriger dans le contrat »).

Retenu : un niveau de répertoire, `INGEST_DIR/<slug>/`. Le json ne change
pas, la version de schéma reste 1, et le script post-enregistrement
FreeSWITCH n'a qu'à écrire dans le bon répertoire. Écartés : un champ
`tenant` dans le json (couple la capture au portail), un plan de
numérotation `near` → locataire (à administrer, et un poste peut changer
d'entité), un `INGEST_TENANT` par instance (l'ingestion cesserait d'être
multi-locataire).

Deux conséquences assumées :

- `Tenant.slug` — identifiant stable et sûr en chemin, distinct du nom
  commercial qui, lui, peut changer sans déplacer une arborescence que la
  capture alimente.
- `AuditEvent.tenantId` devient **nullable**, écart au §5. Tracer un dépôt
  tombé dans un répertoire inconnu ou désactivé était impossible autrement :
  il n'y a aucun locataire à qui l'attribuer. La seule alternative — un
  faux locataire « système » — aurait pollué toutes les listes de
  locataires pour éviter un `null` honnête. Le cloisonnement est
  inchangé : une requête d'un locataire filtre sur son `tenantId` et ne
  voit donc jamais ces événements ; ils sont réservés à l'ADMIN de
  l'instance.

**Réserve** — si la capture devait un jour alimenter un `INGEST_DIR` qu'elle
ne maîtrise pas (dépôt par un tiers, SIPREC mutualisé), le plan de
numérotation redevient la bonne réponse : il se branche sans toucher au
json, en résolvant le locataire depuis `near` au lieu du répertoire.

### 9.3 Le stockage range par `tenantId`, l'ingestion lit le `slug` (S2)

Le §3 écrit `STORAGE_DIR/<tenant>/<yyyy>/<mm>/` sans dire lequel des deux
identifiants du locataire désigne ce répertoire. Retenu :
`STORAGE_DIR/<tenantId>/<yyyy>/<mm>/`, alors que l'ingestion, elle, lit le
`slug` dans `INGEST_DIR/<slug>/` (§9.2). L'asymétrie est voulue et tient à ce
que chacun des deux chemins doit garantir.

Le chemin d'une preuve ne doit jamais dépendre d'une donnée renommable. Un
`slug` se renomme : changement de raison sociale, fusion de deux filiales,
correction d'une coquille à l'administration. Le jour où cela arrive,
`Recording.filePath` désignerait un répertoire qui n'existe plus, et une
conservation probante se réparerait à coups de déplacements de fichiers et
de mises à jour de colonnes — exactement le genre d'opération qu'un
contrôleur COBAC est fondé à trouver suspecte. Le `tenantId` ne se renomme
pas : il naît avec le locataire et meurt avec lui.

Côté ingestion, l'exigence est inverse : c'est un humain qui configure le
script post-enregistrement FreeSWITCH, et un `slug` lisible se vérifie d'un
coup d'œil là où un identifiant opaque se recopie de travers. Le répertoire
d'ingestion est un point de passage, pas un lieu de conservation : un `slug`
qui change s'y répercute par une ligne de configuration, sans qu'aucune
preuve ne bouge.

**Réserve** — si un jour un opérateur doit retrouver un enregistrement dans
`STORAGE_DIR` sans passer par le portail, l'arborescence en identifiants
opaques devient hostile. La réponse n'est pas de renommer les répertoires,
mais d'ajouter la correspondance là où elle ne coûte rien : un index
`slug → tenantId` exporté à côté du stockage, ou une commande
d'administration qui résout un chemin. Les fichiers rangés ne bougent pas.

### 9.4 Le lecteur audio présente un billet, pas le jeton de session (S3)

Le §6 demande un lecteur en flux avec `Range` et un `AuditEvent LISTEN` à
chaque lecture. Un `<audio src="…">` réclame lui-même le fichier, par une
suite de requêtes que le portail ne fabrique pas : il ne peut y joindre aucun
en-tête `Authorization`. Il fallait donc décider comment cette route
s'authentifie.

Retenu : l'écoute s'ouvre en deux temps. Le portail appelle
`POST /api/recordings/:id/listen` avec son jeton habituel ; l'api inscrit
l'`AuditEvent LISTEN` et rend un **billet d'écoute** — un JWT court
(`LISTEN_TICKET_TTL`, 30 min par défaut) qui ne vaut que pour un compte, un
locataire et un enregistrement. Le lecteur le passe ensuite en paramètre de
`GET /api/recordings/:id/audio`, qui ne trace rien.

Deux conséquences, toutes deux voulues :

- **Une entrée au journal par écoute, pas par requête HTTP.** Un appel de
  dix minutes provoque une trace, non les trente requêtes `Range` qu'un
  navigateur envoie pour le charger et s'y déplacer. Le journal reste ce
  qu'un contrôleur peut lire : la liste des consultations, pas celle des
  aléas de mise en mémoire tampon. Rouvrir la même écoute une heure plus
  tard produit une nouvelle trace, ce qui est exact.
- **Le billet est signé avec un secret dérivé de `JWT_ACCESS_SECRET`**, et
  non avec lui. Un billet présenté en `Bearer` ne s'authentifie donc pas :
  la séparation est structurelle et ne dépend d'aucun champ qu'on pourrait
  oublier de vérifier. C'est testé.

Écartés : passer le jeton d'accès en paramètre d'URL (un identifiant de
session complet dans les journaux de serveurs et l'historique du
navigateur) ; charger l'audio par `fetch` autorisé puis le lire depuis un
`blob:` (le portail téléchargerait dix minutes d'audio avant la première
seconde entendue, et le `Range` du §6 ne servirait plus à rien) ; tracer
chaque requête `Range` (le journal deviendrait illisible).

**Réserve** — un billet reste un porteur d'accès glissé dans une URL. Tant
que le portail et l'api partagent une origine, il ne quitte pas la machine
de l'auditeur. Le jour où l'audio serait servi par un tiers (CDN, stockage
objet signé), il faudra le raccourcir nettement et le lier à l'adresse IP
du demandeur ; le point d'inscription au journal, lui, ne bouge pas.

### 9.5 Deux pans du §6 sont tenus jusqu'à la fin du S4 (S3)

La revue de sortie du S3 constate deux manques par rapport au §6, tous deux
connus et tous deux reportés à la **fin du S4**, après la rétention, le legal
hold, la purge et l'export :

- **Le journal d'audit n'a pas d'écran.** `AppShell` propose bien l'entrée
  « Journal d'audit », masquée aux rôles qui n'y ont pas droit, mais aucune
  route ne la sert : le portail redirige vers la liste des enregistrements.
  Le §7 place cet écran en S4, et l'api n'expose pas encore de route de
  lecture du journal — les données existent, la vue non.
- **Le tableau de bord du §6** (volume par jour, durée totale, stockage
  utilisé, dernières quarantaines) n'est rattaché à aucun jalon du §7. Il est
  arrimé ici à la fin du S4.

Le lien mort est assumé plutôt que retiré : il dit à l'auditeur, dès
aujourd'hui, que le journal qu'on lui promet existe et lui sera ouvert. Le
retirer pour le remettre en S4 coûterait deux modifications au lieu d'une et
ferait disparaître de l'écran la seule trace visible d'un engagement produit.
La contrepartie est qu'il ne doit pas survivre au S4 dans cet état.

**Réserve** — cette tolérance vaut pour un portail qu'aucun client n'utilise
encore. À la première mise en service réelle, un lien qui ne mène nulle part
n'est plus une promesse mais un défaut : si le S4 devait glisser au-delà d'une
mise en service, le lien se désactive (visible, mais inerte et annoncé comme
« à venir ») plutôt que de rediriger silencieusement.
