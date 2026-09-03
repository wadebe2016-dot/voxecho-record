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
  "source": "cucm-bib",         // cucm-bib | siprec | simulator
  "category": "confirmation_cheque"  // FACULTATIF — confirmation_cheque |
                                //   operation_change | autre (§9.10)
}
```

Le champ `category` est **facultatif** et n'emporte pas de changement de
version : un producteur qui l'ignore reste conforme au schéma 1, et son dépôt
est rangé en `autre`. Une valeur hors de la liste connue, en revanche, part en
quarantaine — une catégorie que personne n'a déclarée est une faute de frappe
jusqu'à preuve du contraire.

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
- Deux lots techniquement soudés — le second n'ayant de sens que si le
  premier est là, comme 06 (chiffrement) et 07 (sauvegarde, qui doit savoir
  reconnaître la clé) — peuvent s'enchaîner sans attendre : l'annoncer en une
  ligne avant d'ouvrir le second, et rendre les deux ensemble. Deux lots
  indépendants, eux, restent au feu vert : on finit, on montre, on attend
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

### 9.6 La conservation se décide, se déroge, et se trace (S4)

Le §5 pose `RetentionPolicy` et `LegalHold` sans dire qui arbitre quand les
deux se contredisent, ni ce qui empêche de ramener une rétention à trente
jours un vendredi soir. Trois choix ont été faits en ouvrant le S4.

**Le défaut est de 730 jours, et il y a un plancher.** Deux ans est la durée
retenue au titre des exigences réglementaires bancaires (voir §9.9 pour le
fondement et sa portée) ; *la cote de texte reste à préciser* et n'est
volontairement citée nulle part dans le produit — une référence inventée dans
un document de conformité vaut moins que pas de référence du tout. La valeur est réglable par locataire. En dessous du
plancher de l'instance (`RETENTION_MIN_DAYS`, 730 par défaut), l'api refuse la
politique **sauf motif écrit d'au moins dix caractères**, conservé sur la
politique en vigueur (`RetentionPolicy.belowFloorReason`) et inscrit au
journal. « Jamais moins sans décision explicite » suppose que la décision
existe quelque part de lisible : ici, un contrôleur voit du premier coup d'œil
qu'il lit une politique dérogatoire, et le journal lui dit qui a dérogé.

Le motif est exigé *uniquement* en dessous du plancher, et refusé au-dessus :
faire justifier un allongement transformerait la prudence en corvée, et un
motif de dérogation accroché à une politique qui ne déroge à rien ferait
croire à une dérogation qu'il n'y a pas.

**`AuditAction` gagne `RETENTION_SET`** — écart au §5. Raccourcir une
conservation, c'est programmer la destruction de preuves à terme ; sans cette
action, l'acte le plus lourd du produit était le seul à ne rien laisser au
journal. La trace porte l'avant, l'après, le plancher, le motif éventuel, et
si la durée a été raccourcie.

**`RecordingStatus.hold` n'est pas utilisé** — écart au §5 également. Une
conservation forcée est une ligne non levée de `LegalHold`, et c'est la seule
source de vérité ; `Recording.status` continue de décrire le fichier
(`stored`, `archived`, `purged`). Deux représentations du même fait finissent
toujours par diverger, et le jour où elles divergeraient, c'est la purge qui
arbitrerait — au pire moment, sur la pièce qu'on cherchait justement à
protéger. Le portail affiche le hold à côté du statut, jamais à sa place.

Poser et lever sont ouverts à l'ADMIN et au SUPERVISOR, l'AUDITOR consulte
l'historique sans y toucher : il constate, il n'ordonne pas. La levée se
motive comme la pose — elle rend l'appel purgeable, c'est une destruction
différée.

**Réserve** — le plancher est un garde-fou d'instance, pas une règle de droit.
Le jour où la référence réglementaire sera établie, deux choses changent : la
valeur par défaut s'aligne sur le texte, et la dérogation cesse d'être une
simple ligne de motif pour devenir une décision datée et nominative, à
présenter en cas de contrôle. Si une offre mutualisée voit le jour (§9.1), le
plancher devra en outre devenir propre à chaque locataire : deux clients d'une
même instance peuvent relever de régimes différents.

### 9.7 La purge s'autorise sur pièce, elle ne se déclenche pas toute seule (S4)

Le §5 dit « la purge respecte les holds, chaque purge est un AuditEvent » sans
dire qui la déclenche. Trois choix en découlent.

**Aucune purge automatique.** Le produit énumère, un responsable conformité
valide, un ADMIN exécute. Un balayage qui détruirait de lui-même des pièces
probantes à l'échéance ferait de la conservation une affaire de `cron` : le
jour où une rétention est mal réglée, personne n'aurait rien signé. La
contrepartie est assumée — sans intervention humaine, rien n'est jamais purgé
et le stockage croît. C'est le bon sens de ce produit : on préfère un disque
plein à une preuve détruite par inadvertance.

**Le rapport est l'autorisation, pas un affichage.** Une simulation crée un
`PurgeRun` figé : la politique en vigueur, l'échéance qui en découle, la liste
énumérée des appels échus, ce qu'ils pèsent, et ceux qu'une conservation forcée
épargne — avec le motif du hold, pour que le rapport se lise sans autre source.
L'exécution désigne ce rapport par son identifiant et le **rejoue** : même
échéance, même politique, jamais recalculées à la date du jour.

Une empreinte de l'ensemble énuméré (identifiants triés, état de hold compris)
est conservée. Si la réalité ne lui correspond plus à l'exécution — un hold
posé depuis, un appel qui a franchi l'échéance entre-temps, une politique
modifiée — l'exécution est refusée et il faut établir un nouveau rapport. Ce
qui a été autorisé doit être exactement ce qui est détruit ; une autorisation
qui porte sur un ensemble mouvant n'autorise rien.

**La simulation n'ajoute pas d'action au journal.** Le `PurgeRun` est
lui-même la trace : daté, attribué, immuable, consultable, et il survit à
l'exécution. Ajouter un `PURGE_SIMULATED` au §5 aurait dédoublé cette trace
sans rien apprendre à personne. Le journal, lui, reçoit un `PURGE` **par
enregistrement détruit**, portant le motif, l'identifiant du rapport, la
politique appliquée, et l'empreinte SHA-256 de ce qui vient de disparaître.

**Ce qui reste d'un appel purgé.** Le fichier est détruit ; la ligne subsiste
en `purged` avec son empreinte, sa taille, son chemin et sa durée. Elle
continue de sortir dans les recherches — l'écoute rend `410`, pas `404`. C'est
volontaire : effacer la ligne effacerait la preuve qu'il y avait quelque chose
à purger, et un contrôleur qui demande « qu'avez-vous détruit, et quand ? »
doit trouver une réponse ailleurs que dans un silence. Un fichier déjà absent
du stockage au moment de la purge n'interrompt pas l'opération : il est
consigné comme tel (`fichierDejaAbsent`), car c'est un incident d'intégrité
qui mérite une trace, pas un échec qui mérite un arrêt.

**Réserve** — l'absence de purge automatique tiendra tant qu'un exploitant
peut suivre le rythme. Le jour où un client gère des dizaines de locataires,
il faudra une purge programmée ; elle ne devra pas court-circuiter le rapport
mais l'établir automatiquement, notifier, et attendre une validation — la
signature reste humaine. Par ailleurs, l'empreinte invalide un rapport dès
qu'un seul appel change d'état : sur un gros volume où des appels franchissent
l'échéance en continu, un rapport pourrait devenir inexécutable avant d'avoir
été lu. Si cela se produit, la réponse est de figer l'ensemble par les
identifiants énumérés plutôt que par un recensement rejoué — pas d'assouplir
la vérification.

### 9.8 L'export vérifie l'empreinte au lieu de l'affirmer (S4)

Le §6 demande « wav + fiche PDF/JSON horodatée (métadonnées, sha256,
demandeur) ». Un export est ce qui **sort** du produit : il circulera par
courriel, sur une clé, dans un dossier de contrôle, loin du portail qui l'a
produit. Il doit donc se suffire à lui-même. Trois choix en découlent.

**Une archive ZIP, trois pièces** : le fichier audio sous le nom que lui donne
le contrat §3, une `fiche.pdf` d'une page, une `fiche.json` de même contenu.
Le PDF pour l'humain qui l'agrafe à son dossier, le JSON pour ce qui viendra
le relire. La fiche porte l'empreinte **en entier** : tronquée, elle ne
servirait à rien, puisqu'elle n'est là que pour être comparée. Aucune police
n'est embarquée — Helvetica et Courier sont garanties par le format, et un
export ne doit dépendre d'aucun fichier présent sur la machine qui l'a produit.

**L'empreinte est recalculée sur le fichier au moment de l'export**, puis
confrontée à celle relevée à l'ingestion. C'est tout l'intérêt de la manœuvre :
la fiche n'affirme pas que la pièce est intacte parce que la base le dit, elle
le vérifie et le date. Le journal reçoit les deux empreintes et le résultat de
la comparaison — c'est ce qui permettra un jour de dater le moment où une
pièce a commencé à diverger.

**Une divergence n'empêche pas l'export, elle l'annote.** Le fichier sort, mais
la fiche PDF s'ouvre sur un avertissement, le JSON porte
`integrite: "divergente"`, le portail le dit à l'écran et le journal le
consigne. Refuser l'export était l'autre option : elle a été écartée parce
qu'elle empêcherait de sortir la pièce pour enquêter précisément sur ce qui lui
est arrivé, et parce qu'un `410` se lit « l'outil est cassé » alors qu'un
avertissement se lit « cette pièce est suspecte ». Le principe retenu : le
produit ne refuse pas de livrer, il refuse de mentir.

**Pas de billet d'écoute ici**, contrairement au §9.4. Le billet n'existe que
parce qu'un `<audio>` ne peut porter aucun en-tête ; l'export, lui, est demandé
par le portail lui-même, qui joint son jeton et reçoit l'archive en réponse.
Rien ne passe donc par l'url. Et la lecture par plages n'aurait aucun sens sur
un aller simple : on attend le fichier entier de toute façon.

L'export est ouvert aux trois rôles. Sortir une pièce fait partie du métier
d'un auditeur ; ce qui protège n'est pas l'interdiction, c'est la trace.

**Réserve** — l'archive est fabriquée en mémoire. À 16 000 octets par seconde
d'audio, un appel de dix minutes pèse une dizaine de mégaoctets : c'est sans
conséquence pour une pièce à la fois. Le jour où un export de masse sera
demandé — « tous les appels de ce compte sur le trimestre » — il faudra un
flux et un travail de fond avec notification, pas cette route. Par ailleurs,
l'avertissement de divergence ne protège que tant que la fiche accompagne
l'audio : séparés, le wav circule sans rien qui le signale. Si cela devient un
risque réel, la réponse est de signer l'archive, pas d'alourdir la fiche.

### 9.9 Fondement réglementaire, et qui a le droit d'entendre (S4)

Deux points de doctrine confirmés par le terrain, qui commandent le reste.

**Le fondement est « les exigences réglementaires bancaires »**, formulé ainsi
et pas autrement. Le produit vise au-delà de la zone CEMAC ; la COBAC en est le
premier cadre d'application, non le seul horizon. La cote de texte précise
reste à établir et ne doit être citée nulle part — ni dans l'interface, ni dans
une fiche d'export, ni dans un commentaire — tant qu'elle n'est pas vérifiée.
Une référence approximative dans un produit de conformité est pire qu'une
absence de référence : elle se recopie, et elle finit dans un dossier de
contrôle sous la signature de quelqu'un d'autre.

Concrètement : les durées et les seuils sont des paramètres assumés, pas des
citations. §9.6 s'appuie sur ce fondement pour ses 730 jours.

**Entendre une conversation de client n'est pas un droit d'exploitation.**
L'écoute est réservée aux habilitations d'audit et de conformité — `AUDITOR` et
`ADMIN`. Le `SUPERVISOR` conserve tout le reste : il cherche, il consulte les
métadonnées, il relève l'empreinte, il constate l'intégrité. Il n'entend pas.
La distinction est celle entre surveiller un service et écouter des clients ;
elle est ce qui rend l'outil acceptable dans une banque.

**L'export suit la même habilitation.** Une archive contient l'audio :
l'exporter revient à pouvoir l'entendre, en pire, puisque le fichier quitte
alors le bâtiment. Ouvrir l'export à qui n'a pas l'écoute aurait rendu la
restriction décorative. C'est un resserrement par rapport au S3, où l'export
était ouvert aux trois rôles.

Le portail masque ce que le rôle ne permet pas et **dit pourquoi** plutôt que
de laisser un vide : un superviseur qui ne trouve pas le bouton d'écoute doit
comprendre qu'il s'agit d'une habilitation, non d'une panne. L'api refuse de
toute façon — le masquage n'est qu'un confort d'affichage, et c'est le refus
côté serveur qui est testé.

**Réserve** — les trois rôles du §5 confondent aujourd'hui deux axes :
l'administration de l'instance et l'habilitation métier. `ADMIN` est à la fois
celui qui règle la rétention et celui qui écoute, ce qui va tant que
l'administrateur *est* le responsable conformité — le modèle de déploiement du
§9.1, une instance par client, le garantit à peu près. Le jour où un
exploitant technique aura besoin d'un accès sans habilitation d'écoute, il
faudra séparer les deux axes : un rôle d'administration et une habilitation
d'écoute portée à part, plutôt qu'un quatrième rôle qui recouperait mal les
trois autres.

### 9.10 La catégorie d'opération, ajoutée au contrat sans le rompre (S4)

`Recording` gagne une `operationCategory`. Elle ne décrit pas l'appel — cela,
c'est `direction` — mais **ce qui s'y joue** : une confirmation de chèque et un
ordre de change n'engagent pas la banque de la même façon et ne relèvent pas
nécessairement des mêmes durées de conservation. Valeurs initiales :
`confirmation_cheque`, `operation_change`, `autre`.

**Le contrat §3 est amendé, la version de schéma ne bouge pas.** Le champ
`category` du json est facultatif : un script post-enregistrement écrit avant
cette évolution reste conforme, et son dépôt est rangé en `autre`. C'était la
condition pour ne pas contredire le §7, S5 — « AUCUN changement attendu dans
apps/ » vaut aussi dans l'autre sens : aucun changement exigé de la capture.

**Une valeur inconnue part en quarantaine.** `confirmation_chèque` avec son
accent n'est pas une nouvelle catégorie, c'est une faute de frappe ; l'accepter
créerait un catalogue par accident. C'est la même règle qu'au §3 pour les
locataires : l'ingestion ne crée jamais rien implicitement.

**C'est une chaîne, pas une énumération en base.** Le catalogue doit pouvoir
s'étendre par locataire — une banque et une microfinance n'ont pas les mêmes
opérations — et une énumération PostgreSQL imposerait une migration à chaque
ajout. Le point d'extension prévu est une table `OperationCategory` portant
`tenantId`, qui remplacera la liste fixe du contrat comme référentiel de
validation. Tant qu'elle n'existe pas, la liste fixe *est* le catalogue.

La catégorie est filtrable en recherche, exposée dans la liste, portée par la
fiche d'appel et par les deux fiches d'export.

**Réserve** — le champ est prêt à porter des politiques de rétention
différenciées, il ne les porte pas encore. `RetentionPolicy.appliesTo` vaut
`all` aujourd'hui ; c'est là que la catégorie viendra se brancher, une
politique par catégorie l'emportant sur la politique générale. Deux points
seront à trancher à ce moment : ce qu'il advient d'un appel dont la catégorie
change après coup, et laquelle des deux durées s'applique quand elles
divergent — la plus longue, sauf décision contraire, puisqu'en conservation
c'est le doute qui doit profiter à la preuve.

### 9.11 Le journal se lit, s'extrait, et ne s'écrit jamais par là (S4)

Le §6 demande un journal « consultable par ADMIN/AUDITOR, filtrable, export
CSV ». Il ferme aussi le premier fil laissé ouvert au §9.5 : l'entrée
« Journal d'audit » de la barre de navigation mène désormais quelque part.

**Deux services, pas un.** `AuditService` écrit, `AuditReadService` lit. La
séparation n'est pas cosmétique : le journal est append-only, et une classe
qui sait déjà écrire finit un jour par exposer une méthode qui écrit là où on
croyait lire. Aucune route d'écriture n'existe, et le déclencheur en base
refuse de toute façon.

**Le SUPERVISOR n'y a pas accès**, conformément au §6 — et pour la même raison
qu'il n'écoute pas (§9.9) : le journal dit qui a entendu quoi. Le donner à lire
à qui n'a pas l'habilitation d'écoute reviendrait à lui livrer indirectement
l'activité des auditeurs.

**Lire le journal ne s'inscrit pas au journal, l'extraire si.** Consulter est
l'usage normal de la pièce : tracer chaque page consultée noierait le journal
sous des événements qui ne disent rien, exactement comme tracer chaque requête
`Range` l'aurait noyé au §9.4. Un export CSV, lui, sort du produit : il devient
une pièce autonome qui circulera, et il s'inscrit donc comme un `EXPORT`,
portant l'objet, les critères, le nombre de lignes et le fait que l'extrait
soit tronqué. Aucune action nouvelle n'a été ajoutée au §5 pour cela.

**L'extrait dit s'il est incomplet.** Au-delà de 50 000 lignes, l'export est
tronqué et l'annonce — en-tête de réponse et trace au journal. Un contrôleur
qui croit tenir le journal entier tirerait des conclusions fausses d'un
silence.

**Le CSV est fait pour le tableur qui l'ouvrira.** Séparateur point-virgule,
marque d'ordre d'octets en tête : sans elles, Excel en configuration française
rend une colonne unique et des accents cassés. Les valeurs commençant par `=`,
`+`, `-` ou `@` sont préfixées d'une apostrophe — un motif de conservation
forcée est saisi par un humain, et un champ libre qui finit dans un tableur ne
doit pas s'y exécuter.

**Réserve** — le filtre par auteur porte sur un fragment d'adresse, ce qui
suffit à un journal de quelques milliers de lignes et devient coûteux au-delà.
Si le volume l'impose, ce sera une jointure sur un identifiant de compte
choisi dans une liste, pas un index sur une recherche textuelle. Par ailleurs,
la lecture non tracée vaut tant que le journal reste interne ; si un jour un
auditeur externe obtient un accès, il faudra tracer ses consultations — et
c'est alors la lecture *par un compte externe* qu'on inscrira, pas toute
lecture.

### 9.12 Le tableau de bord dit l'exploitation, pas les personnes (S4)

Le §6 demande « volume/jour, durée totale, stockage utilisé, dernières
quarantaines ». Ce lot referme le second fil du §9.5.

**Il est ouvert aux trois rôles, SUPERVISOR compris**, alors que le journal
d'audit lui est fermé (§9.11). Ce n'est pas une incohérence, c'est la ligne :
le tableau de bord dit *ce que pèse la conservation et si la chaîne tourne*,
jamais *qui a écouté quoi*. Les quarantaines n'ont pas d'auteur humain, et le
reste est du volume. Surveiller un service, c'est précisément le métier d'un
superviseur.

Les quarantaines affichées sont celles du locataire. Celles qu'aucun locataire
ne réclame (§9.2) n'y figurent pas : elles restent réservées à l'ADMIN de
l'instance, depuis le journal.

**Le stockage utilisé ne compte que ce qui est sur le disque.** Un appel purgé
garde sa fiche mais ne pèse plus rien ; il est compté à part, sous un intitulé
qui dit que l'audio a été détruit et la fiche conservée — sans quoi un écart
entre deux chiffres se lirait comme une perte de données.

**Le graphe est mono-série, donc mono-teinte.** Une seule couleur, pas de
légende — le titre nomme la série. Les jours creux sont dessinés à zéro et non
omis : un graphe qui saute les journées vides dessine une activité continue là
où le service a chômé, et c'est exactement le genre de courbe flatteuse qu'un
produit de preuve ne doit pas produire. Un jour à zéro n'a donc aucune hauteur
minimale « pour la visibilité » : zéro reste zéro.

Les mêmes données figurent juste en dessous **en chiffres**. Un contrôleur
recopie des valeurs, il ne mesure pas des barres à l'œil ; et la couleur ne
doit jamais porter seule une information.

**Réserve** — la fenêtre est de trente jours fixes et l'agrégation se fait à
chaque appel. C'est sans conséquence sur les volumes visés, où trente jours
représentent quelques milliers de lignes. Au-delà, la réponse est une table
d'agrégats entretenue à l'ingestion, pas un cache devant cette route : un
chiffre de conformité doit rester recalculable à la demande, et un cache
introduit une fenêtre pendant laquelle l'écran ment.

### 9.13 Le chiffrement scelle par trames pour que la lecture par plages survive (S4)

Le §8 prévoit « AES-256-GCM par fichier, clé maître hors dépôt », et un
stockage conçu pour que l'activation n'impose pas de migration lourde.
L'implémentation retenue précise trois points.

**Un fichier scellé d'un seul tenant ne se lit pas par plages.** Il faudrait
tout déchiffrer à chaque requête d'un lecteur audio, et le `Range` du §6 comme
le billet du §9.4 perdraient leur raison d'être. Le clair est donc découpé en
**trames de 64 Kio**, chacune scellée séparément : même algorithme, même
garantie, mais un octet quelconque se retrouve en ouvrant une seule trame.
Toutes les trames sauf la dernière étant pleines, la position de chacune se
calcule — c'est ce qui rend la lecture par plages possible.

**L'en-tête et l'indice de la trame entrent dans les données authentifiées.**
Sans cela, chaque trame serait authentique isolément et le fichier resterait
falsifiable par simple permutation : on pourrait réordonner une conversation
sans qu'aucun sceau ne proteste. Une trame déplacée, transplantée depuis un
autre fichier, ou un en-tête retouché sont refusés ; c'est testé.

**La clé maître ne chiffre jamais directement.** Chaque fichier a la sienne,
dérivée en HKDF de la clé maître, d'un sel tiré au hasard et de l'identifiant
de l'enregistrement. Deux pièces ne partagent donc aucune clé, et une pièce ne
s'ouvre pas au nom d'un autre appel. `Recording.keyRef` retient quelle clé
maître a servi, ce qui permettra à deux générations de coexister le jour d'une
rotation.

**Ce que la base retient reste le clair.** `sha256` est l'empreinte du wav
ingéré, pas celle du conteneur — c'est la valeur qu'un contrôleur compare à sa
propre copie — et `sizeBytes` est la taille du wav. C'est pour cela que
`Content-Length`, `Content-Range` et le `416` du §6 n'ont pas eu à changer : le
reste de l'api demande des octets de clair et en reçoit, sans savoir si la
pièce est scellée.

**L'activation est progressive.** `STORAGE_ENCRYPTION_ENABLED` ne concerne que
les pièces à venir ; l'api lit indifféremment les deux formats, reconnus à leur
en-tête. La commande `storage:sceller` rattrape l'existant, en simulation par
défaut — une commande qui réécrit des preuves ne doit pas pouvoir partir d'une
faute de frappe. Elle **vérifie l'empreinte avant de sceller** : sceller une
pièce déjà altérée figerait l'altération sous un sceau qui la rendrait ensuite
« authentique ».

**Réserve** — la perte de la clé maître rend le stockage définitivement
illisible : c'est la propriété recherchée, et c'est aussi le risque. Sa garde
et sa sauvegarde sortent du produit, et devront être traitées avec la
sauvegarde de la base (lot 07) plutôt qu'à côté — une base restaurée sans sa
clé ne rend rien. Par ailleurs le scellement charge le fichier entier en
mémoire : sans conséquence sur des appels de quelques mégaoctets, à revoir en
flux si des enregistrements bien plus longs devaient apparaître. Enfin, la
rotation de clé n'est pas outillée : `keyRef` permet aux générations de
coexister, mais rechiffrer un stockage entier demandera une commande dédiée,
et elle devra pouvoir être interrompue et reprise.

### 9.14 Une sauvegarde qui ne se vérifie pas n'est qu'une intention (S4)

Le §9.13 laissait un fil : « la perte de la clé maître rend le stockage
définitivement illisible […] sa garde et sa sauvegarde sortent du produit, et
devront être traitées avec la sauvegarde de la base plutôt qu'à côté — une base
restaurée sans sa clé ne rend rien ». Ce lot le referme. Rien de tout cela ne
figurait au §7 : la sauvegarde n'est pas un jalon, c'est ce sans quoi les cinq
autres ne valent rien le jour d'un sinistre.

**Le produit sauvegarde la base et inventorie le stockage ; il ne recopie pas
les pièces.** Un enregistreur de conformité accumule des dizaines de
gigaoctets d'audio, que les moyens de l'exploitant copient déjà bien mieux
qu'une commande Node ne le ferait — instantané de volume, rsync, sauvegarde
d'entreprise. Ce que le produit seul peut apporter, c'est la **preuve que
cette copie est complète et intacte** : une ligne par pièce avec son empreinte,
sa taille et son état, et une vérification qui confronte cet inventaire au
disque en recalculant chaque empreinte — déchiffrement compris. Copier
l'audio aurait été le geste visible ; savoir dire ce qui manque est le geste
utile.

**La sauvegarde ne contient jamais la clé maître, mais elle sait la
reconnaître.** Y écrire la clé reviendrait à ranger le coffre avec sa
combinaison scotchée dessus, alors qu'une copie de sauvegarde se duplique,
s'emporte hors site et circule. Le manifeste retient donc une **empreinte
publique** de la clé, dérivée sous un contexte qui lui est propre : elle ne
peut ni ouvrir un conteneur, ni remonter à la clé, mais elle permet de dire à
la restauration « ce n'est pas la clé qui a scellé ces pièces » — au lieu de
le découvrir des mois plus tard, à la première écoute demandée par un
contrôleur. La garde de la clé, elle, reste hors du produit ; ce qui entre
dans le produit, c'est le moyen de constater qu'on tient la bonne.

**La vérification dit toujours jusqu'où elle est allée.** Sans clé, les sceaux
ne sont pas ouverts : le rapport déclare les pièces « constatées présentes,
intégrité non vérifiée » plutôt que de les compter comme vérifiées. Une clé qui
ne concorde pas n'est pas utilisée pour tenter d'ouvrir quoi que ce soit. Cette
règle vaut plus que le confort d'un rapport tout vert : un contrôle qui conclut
au-delà de ce qu'il a constaté ne vaut rien, et c'est précisément ce qu'on
reprocherait à l'exploitant.

Sont constatés, et chacun compte comme une anomalie : une pièce absente du
disque, une empreinte qui ne correspond plus à celle relevée à l'ingestion, un
sceau qui refuse de s'ouvrir, une pièce scellée avec une clé que le manifeste
ne connaît pas, un fichier qu'aucun enregistrement ne réclame, la déclaration
d'origine du producteur (le json du contrat §3) disparue d'à côté de sa preuve,
et — signe qu'on aimerait ne jamais voir — un fichier **revenu** à la place
d'une pièce purgée. La sortie de la commande n'est nulle que si rien de tout
cela n'a été trouvé : une vérification qui réussit toujours ne vérifie rien.

**La prise ne s'inscrit pas au journal d'audit.** Aucune action n'est ajoutée
au §5. Sauvegarder ne touche à aucune preuve, ne s'attribue à aucun locataire
et ne s'exécute au nom d'aucun compte : c'est un acte d'exploitation, en ligne
de commande, là où le journal trace des personnes agissant sur des pièces. Le
manifeste **est** la trace — daté, énuméré, empreint, et il survit à la base
qu'il décrit, ce qu'aucune ligne du journal ne saurait faire puisqu'elle
disparaîtrait avec elle. C'est la même logique qu'au §9.7, où le `PurgeRun`
tient lieu de trace de la simulation.

L'empreinte du manifeste s'affiche en fin de prise, à consigner ailleurs :
c'est ce qui permettra de démontrer, plus tard, que la sauvegarde présentée est
bien celle qui a été faite ce jour-là. Une sauvegarde qui s'auto-certifie ne
certifie rien ; le maillon de départ se garde hors d'elle.

**Réserve** — la vérification du stockage relit chaque pièce en entier : c'est
la seule façon de vérifier une empreinte, et c'est aussi ce qui la rend lente
sur un gros volume. Elle est faite pour un contrôle périodique et pour l'après
sinistre, pas pour tourner à chaque heure ; si un balayage continu devient
nécessaire, ce sera par échantillonnage tournant, jamais par un allègement de
ce que la vérification affirme. La détection des fichiers qu'aucun
enregistrement ne réclame tient par ailleurs l'ensemble des chemins du stockage
en mémoire — quelques dizaines d'octets par pièce, à revoir en tri sur fichier
si un stockage devait dépasser le million d'appels. Enfin, la restauration
elle-même n'est pas outillée : `pg_restore` est un outil standard, bien
documenté, et une commande maison qui l'enroberait ajouterait un intermédiaire
au pire moment. C'est en revanche la procédure écrite — restaurer, remettre la
clé, vérifier — qui devra être jouée pour de bon avant la première mise en
service, comme on joue un exercice d'évacuation.

### 9.15 Restaurer se constate, cela ne se déclare pas (S4)

Le §9.14 s'arrêtait où s'arrête une sauvegarde : elle vérifiait la prise, le
stockage et la clé, c'est-à-dire tout ce qu'on peut vérifier **sans**
restaurer. Il y laissait le dernier pas, celui qui compte le jour d'un
sinistre : la base qu'on vient de remonter rend-elle ce qui avait été
sauvegardé ? `restauration:constater` le demande, sur la machine restaurée, à
la base que désigne sa propre `DATABASE_URL`.

**`pg_restore` dit qu'il a fini, pas qu'il a tout rendu.** Un `--schema` de
travers, une table restaurée à moitié, un dump plus ancien qu'on ne croyait,
une base de secours qui contenait déjà autre chose : rien de tout cela ne fait
échouer une restauration, et tout cela se découvrirait des mois plus tard, à la
première pièce réclamée par un contrôleur. Le manifeste et l'inventaire disent
ce qui doit s'y trouver — autant le leur demander pendant que l'exploitant est
encore devant sa console. Sont confrontés : l'état des migrations, les
locataires et leur compte de pièces, et **chaque ligne de l'inventaire**, champ
par champ, empreinte et taille comprises. Le constat nomme ce qui diffère
(« empreinte a… au lieu de 9f… ») plutôt que de signaler qu'il diffère : sur une
base de secours, savoir *quoi* est ce qui décide de la suite.

**Une base plus avancée que la prise n'est pas une anomalie.** Restaurer un
dump puis appliquer les migrations parues depuis est une manœuvre saine ;
l'annoncer « divergente » ferait crier au sinistre sur une opération normale, et
un outil qui crie pour rien finit par ne plus être lu. Sont des anomalies : une
base **en retard** — elle ne peut pas porter ce qu'on y a restauré — et une
**autre lignée** de migrations, qui n'est simplement pas cette instance-là.

**Les enregistrements en trop se comptent sans s'énumérer.** Les nommer
exigerait de tenir tout l'inventaire en mémoire, ce que la réserve du §9.14
refuse déjà pour le stockage ; leur nombre suffit à savoir qu'on ne regarde pas
la base qu'on croit. Ce n'est pas de la paresse : c'est la même règle que
partout ailleurs — ne rien affirmer au-delà de ce qui a été constaté.

**Un constat qui ne dit pas son total ne constate rien.** Les listes
d'anomalies étaient plafonnées à vingt éléments et le rapport annonçait ensuite
la longueur de cette liste : cinq mille pièces disparues se lisaient « 20
pièce(s) absente(s) », et un sinistre passait pour un incident local. Un constat
compte désormais **tout** et n'énumère que les premières, en disant combien il
n'a pas énumérées. La correction vaut aussi pour la vérification du §9.14, où
le même défaut dormait.

**Ce que le constat ne fait pas** : il ne restaure pas. `pg_restore` est un
outil standard, documenté, que les exploitants connaissent ; l'envelopper
ajouterait un intermédiaire de notre fabrication au pire moment, et il faudrait
le déboguer un soir de panne. Le produit fournit ce que `pg_restore` ne peut pas
donner — la confrontation à ce qui avait été pris — et laisse la manœuvre à
l'outil dont c'est le métier. La commande rappelle d'ailleurs, quand tout
concorde, qu'une base seule ne fait pas une restauration : sans les fichiers
elle ne rend que des fiches, et sans la clé elle ne rend rien d'audible.

**Réserve** — le constat confronte la base à l'inventaire, donc à ce que la base
disait d'elle-même au moment de la prise ; il ne rejoue pas les empreintes des
fichiers, qui relèvent de `sauvegarde:verifier --stockage`. Les deux commandes
sont complémentaires et devront un jour être enchaînées par une procédure
d'exercice écrite — restaurer, remettre la clé, constater, vérifier — plutôt que
par la mémoire de celui qui l'a fait la dernière fois. Par ailleurs, le compte
des enregistrements en trop se déduit d'une différence : il dit qu'il y en a,
jamais lesquels, et une base de secours contenant deux jeux de données mêlés
demanderait un examen à part.

### 9.16 On ne croit une adresse que si l'on sait qui la rapporte (hors jalon)

Premier lot du durcissement, ouvert après le S4 et avant toute mise en ligne.
La réserve du §9.5 l'annonçait : les tolérances du portail valaient « tant
qu'aucun client ne l'utilise ». Une démonstration publique est une mise en
service.

**L'adresse inscrite au journal était fausse dès qu'on livrait.** Le §5 veut
une `ip` sur chaque événement ; derrière le nginx du livrable, `request.ip`
vaut l'adresse du conteneur qui relaie, et toutes les entrées portaient donc la
même. Express sait lire `X-Forwarded-For`, mais le lui demander sans réserve
serait pire que le mal : cet en-tête est écrit par le client, et n'importe qui
choisirait alors l'adresse inscrite à son nom dans un journal append-only
qu'aucune route ne peut corriger — tout en se rendant invisible d'une
limitation par adresse. La confiance est donc **nominative** : `TRUSTED_PROXIES`
énumère les relais qu'on a soi-même installés, et **vide par défaut**. Une api
exposée directement ne croit que sa socket.

**La limitation par adresse ne compte que les échecs.** Dans une banque, tout
le personnel sort par une même adresse publique : compter les tentatives
réussies rationnerait un service entier au motif qu'il est nombreux. Un
balayage, lui, produit des échecs — c'est cela qu'on mesure. Une connexion
réussie ne remet rien à zéro, sans quoi un attaquant disposant d'un compte
valide effacerait son compteur entre deux salves ; les échecs s'oublient
d'eux-mêmes en sortant de la fenêtre.

Elle ne remplace pas le verrouillage de compte du §5, elle le complète : l'un
protège un compte nommé, l'autre freine celui qui essaie mille comptes à la
suite. Le verrouillage seul laissait passer le balayage, et il est lui-même une
arme — cinq erreurs volontaires suffisent à priver un auditeur de son accès un
quart d'heure. La limitation ne corrige pas ce défaut-là ; elle en réduit la
portée, et le fait qu'un compte se déverrouille tout seul le borne.

**Elle est posée sur les routes d'authentification, jamais globalement.** La
réécoute d'un appel de dix minutes provoque des dizaines de requêtes `Range`
(§9.4) : une limitation générale casserait l'écoute au premier déplacement dans
la conversation.

**C'est le blocage qui s'inscrit au journal, pas la tentative.** Une entrée par
épisode, sans locataire ni compte — on ne sait pas qui frappe, et c'est
précisément ce qu'il faut consigner ; le précédent est au §9.2. Tracer chaque
tentative offrirait à un inconnu le moyen de gonfler à volonté un journal que
rien ne peut purger, ce qui serait un déni de service offert avec la
protection. Aucune action n'est ajoutée au §5 : c'est un `LOGIN` dont le
`resultat` vaut `bloque_par_limitation`.

**La politique de contenu du portail est vérifiée par un build, pas par une
relecture.** La CSP servie par nginx n'autorise aucun inline ; elle ne tient que
tant que la construction n'émet ni `<script>` ni `<style>` dans la page. Le jour
où un outil en émettrait un, le portail cesserait de fonctionner **en
production seulement**, là où aucun test ne regarde. Le test construit donc
pour de bon et relit le résultat.

**HSTS n'est émis que derrière une terminaison TLS déclarée.** Il promet au
navigateur que le domaine se joint en HTTPS et l'y contraint des mois durant :
le promettre depuis une api en clair est une promesse qu'on ne tient pas.

**Réserve** — le compteur vit en mémoire. C'est exact pour le modèle de
déploiement du §9.1, une instance par client ; le jour où deux instances
serviraient le même portail, chacune ne verrait qu'une part des échecs et la
limitation deviendrait deux fois plus permissive qu'annoncée. Il faudra alors un
magasin partagé, et c'est à ce moment qu'un paquet éprouvé se justifiera plutôt
que ces quelques dizaines de lignes. Par ailleurs, la mémoire est bornée à
`AUTH_RATE_MAX_ADRESSES` : au-delà, les adresses les moins récentes sont
oubliées — oublier un attaquant discret est le prix à payer pour ne pas se
laisser épuiser par un attaquant nombreux. Enfin, la terminaison TLS elle-même
n'est pas dans ce lot : elle appartient au déploiement de `record.voxecho.cm`,
et tant qu'elle n'est pas posée, `API_BEHIND_TLS` doit rester faux.

### 9.17 Le script de capture vit ici, mais ne connaît rien d'ici (S5)

Premier lot du S5, ouvert sans CUCM parce qu'il n'en a pas besoin. Le §7
annonce qu'au branchement réel, « AUCUN changement n'est attendu dans `apps/` ;
si un changement est nécessaire, c'est un bug du contrat, à corriger dans le
contrat ». Une promesse pareille se vérifie avant le jour du branchement, pas
pendant : découvrir un bug du contrat en labo, avec le CUCM sous les yeux et
l'intégrateur qui attend, coûte une journée ; le découvrir maintenant coûte une
correction.

**Le script vit dans le dépôt, la capture reste dehors.** `tools/freeswitch/`
n'est pas une entorse au §3 : rien dans `apps/` ne l'importe, et lui n'importe
rien de `apps/`. Il est l'**implémentation de référence** du contrat, au même
titre que le simulateur du §4 — l'un montre ce qu'un producteur doit écrire,
l'autre le fabrique sans téléphonie. Le laisser hors dépôt aurait signifié qu'il
vieillisse séparément du contrat qu'il applique, et que personne ne s'aperçoive
d'une divergence avant une mise en service.

**En bash, pas en TypeScript.** Le reste du dépôt est en Node ; ce script ne
peut pas l'être. Il s'exécute sur un FreeSWITCH de production, où exiger Node
serait une contrainte d'exploitation imposée à un intégrateur qui n'a rien
demandé. Il n'utilise donc que des utilitaires ordinaires — pas même `jq`, dont
l'absence sur une machine de capture serait découverte au premier appel : le
json est écrit à la main, ce qui n'est acceptable que parce que **tous les
champs sont validés avant d'être écrits**, et refusés sinon.

**Il refuse au lieu de deviner.** Fréquence autre que 8 kHz, wav tronqué au
regard de la durée annoncée, horodatage sans fuseau, sens, source ou catégorie
hors contrat, locataire qui ne peut pas être un nom de répertoire, option
inconnue — chacun de ces cas arrête le script. Le portail les mettrait de toute
façon en quarantaine, avec un événement d'audit et un fichier à reprendre à la
main : mieux vaut échouer sur la machine de capture, bruyamment, pendant que
l'appel est encore frais. Une option inconnue est refusée pour la même raison
qu'au §9.16 : un dialplan qui croit transmettre une information que personne ne
lit doit s'en apercevoir tout de suite.

**Le fichier de travail ne passe jamais sous surveillance.** La paire est
préparée hors d'`INGEST_DIR` puis déplacée par un renommage, atomique sur un
même système de fichiers. Un temporaire déposé sous surveillance partirait en
quarantaine à chaque appel, le portail ne reconnaissant que `.wav` et `.json` —
la protection du §3 se serait retournée contre le producteur qu'elle sert.

**Il ne connaît pas la liste des locataires**, et ne peut donc pas savoir si le
slug qu'on lui donne existe. C'est voulu : l'interroger supposerait un accès à
l'api, c'est-à-dire la fin de la frontière du §3. Le portail tranche seul, et un
dépôt visant un locataire inconnu part en quarantaine sans locataire à qui
l'attribuer (§9.2). La faute de frappe se paie donc d'un aller-retour ; c'est
moins cher qu'un couplage.

**Le contrat est vérifié des deux côtés.** Les tests de `tools/freeswitch`
relisent le dépôt avec les validateurs du contrat eux-mêmes, comme au S2 pour le
simulateur ; `apps/api/test/capture-freeswitch.spec.ts` le fait ingérer par le
portail, sans aménagement. Ce n'est pas la même vérification : un dépôt peut
satisfaire le schéma et rester inexploitable. Aucun changement n'a été
nécessaire dans `apps/` — le contrat tient.

**Réserve** — ce que ce lot ne peut pas prouver, c'est que FreeSWITCH appellera
le script avec les bonnes variables. Le dialplan documenté est plausible, il
n'est pas éprouvé : `strftime(%z)` rend `+0100` là où le contrat attend
`+01:00`, et c'est exactement le genre de détail qui ne se découvre qu'en labo.
Le script refuse cette forme plutôt que de la corriger, parce que corriger
silencieusement un horodatage serait s'autoriser à réécrire une donnée probante.
Par ailleurs, la conversion d'un enregistrement qui ne serait pas en 8 kHz n'est
pas outillée : on la refuse, et c'est `record_sample_rate` qu'on règle. Si un
jour une capture impose un autre format, la conversion devra être une étape
déclarée et tracée, jamais un rattrapage silencieux dans ce script.

### 9.18 Une démonstration doit dire qu'elle en est une (hors jalon)

Mise en ligne de `record.voxecho.cm`, après le durcissement du §9.16 et avant
le kit de branchement. Quatre décisions.

**Le portail annonce l'instance de démonstration, et c'est l'instance qui le
commande.** Un visiteur qui voit des appels, des empreintes, un journal
d'audit et un lecteur audio n'a aucun moyen de savoir s'il regarde des
conversations fabriquées ou celles des clients d'une banque. Le laisser dans ce
doute serait le dark-pattern que le §6 proscrit, et le plus grave qui soit pour
un produit dont toute la valeur est la preuve. La mention ne peut pas non plus
être figée dans l'image, sinon elle apparaîtrait chez un client et jetterait un
doute sur des pièces qui, elles, sont réelles : elle vient donc d'une route
publique, `GET /api/instance`, que l'écran de connexion interroge avant toute
session. Si l'api ne répond pas, l'écran reste utilisable et ne dit rien — une
panne se constate en essayant de se connecter, pas devant un écran vide.

**Le jeu de démonstration passe par `INGEST_DIR`, jamais par des insertions en
base.** C'est le chemin réel du produit — contrat §3, empreinte à l'ingestion,
scellement — qui range ces appels. Garnir la base directement aurait montré des
enregistrements que l'ingestion n'a jamais vus, avec des empreintes qu'aucun
calcul n'a produites : un contrôleur qui compare une pièce à sa fiche trouverait
tout juste, mais rien n'aurait été prouvé. Un dépôt volontairement malformé
accompagne le lot, pour que les quarantaines du tableau de bord ne soient pas
vides : la chaîne doit se montrer en train d'écarter sans détruire en silence.

**Les mots de passe de démonstration viennent de l'environnement, et le seed
refuse les valeurs devinables.** L'instance est publique ; des identifiants
écrits dans le dépôt y ouvriraient un portail qui sert de l'audio et affiche un
journal d'audit, et la première démonstration faite à un client se ferait sur
une instance que n'importe qui a pu visiter avant lui. C'est la règle du §2 —
« pas de secret en dur », « secret d'exemple refusé » — appliquée là où on est
le plus tenté d'y déroger, parce que « ce n'est qu'une démo ».

**Les images sont construites par la CI, jamais sur l'instance.** Une t3.small a
deux gigaoctets de mémoire : la construction y échouerait, et un déploiement qui
compile sur la machine de production n'est de toute façon pas reproductible.
GHCR reçoit une image par commit de `main`, taguée par SHA ; revenir en arrière
est un changement de variable, pas une reconstruction.

**Le TLS est terminé par Caddy, en amont de nginx qui ne change pas.** Le
livrable du §2 reste ce qu'un client installerait chez lui ; la démonstration
lui ajoute une couche, elle ne le réécrit pas. Conséquence à ne pas manquer : la
chaîne devient Caddy → nginx → api, et `TRUSTED_PROXIES` doit couvrir le réseau
des conteneurs, faute de quoi toutes les entrées du journal porteraient
l'adresse d'un relais — le défaut que le §9.16 vient de corriger reviendrait par
la porte du déploiement. Caddy ne compresse rien : la réécoute réclame des
plages d'octets (§9.4), et une couche qui recompresse à la volée fausserait les
`Content-Length` et `Content-Range` dont elle dépend.

**Réserve** — l'enregistrement DNS est en « DNS only » pour que les
conversations ne transitent par aucun intermédiaire qui les déchiffrerait au
passage ; l'adresse de l'instance est donc publique, et c'est le groupe de
sécurité qui la protège. Par ailleurs, une démonstration vieillit : les appels
du jeu portent des dates relatives au jour du seed, et une instance laissée six
mois montrera un tableau de bord vide sur ses trente derniers jours. Regarnir
demande alors de relancer le seed, ce qu'il sait faire sans dupliquer. Enfin, la
clé maître de cette instance protège des conversations fabriquées : sa perte
coûte un reseed, pas une preuve. Ce confort ne doit pas déteindre sur la
procédure d'un client, où la même perte est définitive (§9.14).

### 9.19 Une URL de connexion se construit, elle ne se concatène pas (hors jalon)

Constaté à la mise en service de la démonstration : l'api redémarrait en boucle
sur `P1013: invalid port number in database URL`, la base et le portail tournant
normalement. Le compose assemblait l'URL de connexion par concaténation —
`postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/…` — et le mot de
passe, tiré en base64, contenait un `/`. Le premier `/` referme la partie
autorité d'une URL : ce qui suit n'était plus un port.

**Le message d'erreur désignait le mauvais coupable**, et c'est ce qui rend ce
défaut coûteux : on cherche du côté du port, de la résolution du nom `db`, du
réseau des conteneurs — jamais du mot de passe. Une correction qui se serait
contentée de changer le générateur de secrets aurait fait disparaître le
symptôme sans traiter la cause, et le prochain exploitant qui choisit son propre
mot de passe l'aurait retrouvé, avec le même message trompeur.

**La composition passe désormais les composants, et le produit construit
l'URL** en pourcent-encodant l'identifiant et le mot de passe. Une
`DATABASE_URL` fournie entière l'emporte toujours : c'est ce que donnent le
développement et la CI, et un déploiement qui la fournit ne doit pas voir sa
valeur refabriquée dans son dos.

**Le point d'entrée de l'image la construit avant de migrer**, en appelant le
même module que l'application — il n'y a donc qu'un seul encodage, écrit une
fois, testé une fois. Les commandes d'exploitation (seed, sauvegarde, scellement)
court-circuitent ce point d'entrée : elles appellent la même fonction en tête de
leur exécution.

**Le générateur de secrets du runbook évite malgré tout `/` et `+`.** Ce n'est
pas une redondance inutile : ce mot de passe passe aussi par `psql`, `pg_dump` et
les journaux d'exploitation, où un caractère gênant se paie en échappement
oublié. L'encodage protège le produit ; le choix du caractère protège
l'exploitant.

**Ce qui le prouve** : un test crée un vrai rôle PostgreSQL dont le mot de passe
contient `/`, `+` et `=`, s'y connecte par l'URL construite, et vérifie que la
même connexion assemblée à l'ancienne échoue. Comparer deux chaînes écrites par
la même main n'aurait rien prouvé. Un garde-fou refuse par ailleurs toute
concaténation d'URL réintroduite dans un compose.

**Réserve** — l'encodage traite l'identifiant et le mot de passe, pas le nom de
base ni l'hôte, qui restent supposés sobres ; c'est vrai de tout déploiement
raisonnable, et le jour où ce ne le serait plus, l'erreur porterait au moins sur
un champ que l'exploitant a lui-même choisi. Par ailleurs, changer
`POSTGRES_PASSWORD` après le premier démarrage ne suffit pas : le rôle a été créé
dans le volume avec l'ancien, et c'est une opération d'administration de la base,
pas une variable d'environnement.

### 9.20 L'écran de connexion se présente par ce que fait le produit (hors jalon)

Le nom de l'éditeur et sa ville ont été retirés de l'écran de connexion :
« VoxEcho Record — Enregistrement d'appels de conformité », sans ancrage
géographique ni signature.

C'est une décision de positionnement, prise sur un constat de terrain : une DSI
bancaire qui évalue un enregistreur de conformité voit cet écran avant tout le
reste, et un ancrage local y pèse plus lourd dans son jugement que ce que
l'outil apporte. Le §1 vise d'ailleurs la zone CEMAC comme premier cadre
d'application, non comme horizon — c'est la même ligne qu'au §9.9, où le
fondement réglementaire a été formulé « exigences réglementaires bancaires »
plutôt que par une cote de texte locale.

**Ce qui reste sur l'écran** : le nom du produit, ce qu'il fait, l'avertissement
que chaque consultation est tracée, et l'information de verrouillage après
plusieurs échecs. Cette dernière n'est pas une signature mais une explication :
sans elle, un auditeur verrouillé se heurte à un refus qu'il ne comprend pas.

**Ce qui ne change pas** : le fuseau d'affichage reste Africa/Douala (§1), et
c'est autre chose — l'heure à laquelle un appel a été passé est une donnée
probante, pas un élément de présentation. L'éditeur reste nommé là où il
engage : documents contractuels, dépôt, mentions légales du site commercial.

**Réserve** — une page de connexion muette sur son éditeur ne peut pas le rester
partout : dès qu'un client installe le produit chez lui, la mention légale doit
être joignable quelque part, et la question se reposera lorsqu'un écran « à
propos » ou une page d'aide existera. Le silence vaut ici parce que cet écran
est une porte, pas une documentation.

### 9.21 « Version d'évaluation » plutôt que « démonstration » (hors jalon)

Amende le vocabulaire du §9.18, dont la décision de fond ne change pas : une
instance servie sur l'internet public avec des appels fabriqués doit le dire, et
c'est l'instance qui le commande.

**Le mot change parce qu'il n'est pas neutre.** Une « démonstration » se regarde
comme une vitrine ; une « version d'évaluation » s'essaie comme un produit qu'on
envisage d'acheter. La DSI bancaire à qui l'on ouvre `record.voxecho.cm` n'est
pas venue voir un spectacle, elle est venue vérifier si l'outil tient. C'est la
même ligne que le §9.20 : ce que le produit dit de lui-même compte autant que ce
qu'il fait, sur un marché où la crédibilité de l'éditeur conditionne l'examen
technique.

**Ce que le mot ne change pas.** Le bandeau reste, et il dit toujours la même
chose : les appels sont fabriqués, aucune conversation réelle de client n'y
figure. C'est la protection du §9.18 — un visiteur ne doit pas pouvoir croire
qu'il regarde les clients d'une banque — et elle vaut quel que soit le nom qu'on
donne à l'instance.

**Le locataire et les comptes portent des noms crédibles.** « Banque de la CEMAC
(démonstration) » annonçait un décor ; « Banque Méridienne » se lit comme un
établissement, et les adresses `@banque-meridienne.cm` comme celles d'un service
conformité. Le nom est fictif à dessein : emprunter celui d'un établissement réel
transformerait une évaluation en usurpation, et les journaux d'audit de
l'instance porteraient le nom d'une banque qui n'a rien demandé.

**Ce qui n'a pas été touché**, et pourquoi. Le jeu de données de développement
(`apps/api/prisma/seed.ts`) garde son vocabulaire : il ne sort jamais d'un poste
de travail, et le renommer aurait déplacé des dizaines d'assertions de test sans
rien changer pour un client. Le test de sortie du jalon S3 s'appelle toujours
« démo bout-en-bout » : c'est le nom que lui donne le §7, et l'aligner
demanderait de modifier le brief pour une question de vocabulaire interne.

**Réserve** — le renommage touche des variables d'environnement
(`INSTANCE_DEMO` → `INSTANCE_EVALUATION`, `DEMO_*` → `EVAL_*`) et les adresses
des comptes. Une instance déjà installée ne se met pas à jour toute seule : son
fichier `.env` garde les anciens noms, et les comptes déjà créés gardent leurs
anciennes adresses. C'est le prix d'un renommage tardif, et il se paie une fois.

### 9.22 Administrer un locataire n'est pas administrer l'instance (S6)

Premier lot de la console d'administration, et paiement d'une dette annoncée :
le §9.9 avait laissé en réserve que « les trois rôles confondent aujourd'hui
deux axes : l'administration de l'instance et l'habilitation métier ». Tant que
le produit se réglait par des variables d'environnement, la confusion ne coûtait
rien. Une console la rend intenable : régler la conservation de sa banque et
régler l'instance qui héberge toutes les banques ne sont pas la même
responsabilité.

**Un privilège porté à part, pas un quatrième rôle.** `User.instanceAdmin`
s'ajoute aux trois rôles sans les recouper — c'est exactement ce que le §9.9
recommandait. Un ADMIN reste l'administrateur de son locataire ; certains sont
en outre administrateurs de l'instance. Un quatrième rôle aurait obligé à
choisir entre administrer et auditer, alors que ces axes sont indépendants.

**Il ne se donne pas depuis le portail.** La promotion passe par une commande
d'exploitation (`admin:instance`), donc par un accès au serveur. Un privilège
qui se donnerait depuis l'écran qu'il déverrouille ne protégerait de rien : un
compte ADMIN compromis s'attribuerait les pleins pouvoirs sur les réglages qui
décident, précisément, de la valeur probante du journal (§9.16). La commande
refuse par ailleurs de promouvoir un compte qui n'est pas déjà ADMIN, ou qui est
désactivé — un chemin détourné vers les pleins droits reste un chemin.

**Durcissement immédiat : le périmètre système du journal suit le privilège.**
Les événements qu'aucun locataire ne réclame (§9.2) étaient lisibles par tout
ADMIN ; sur une instance qui sert plusieurs banques, cela revenait à donner à
chacune un regard sur les incidents des autres. Ils relèvent désormais de
l'administrateur de l'instance. C'est un retrait d'accès, assumé.

**Le premier écran ne change rien, il montre.** C'est déjà beaucoup : répondre à
« quelle conservation minimale impose cette instance ? » ou « à quels relais
fait-elle confiance ? » supposait jusqu'ici d'ouvrir un fichier sur le serveur.
Chaque réglage est accompagné de son effet en une phrase, et ceux qui ne se
changent pas ici — `TRUSTED_PROXIES`, le plancher de conservation — portent la
**raison** de leur lecture seule. Un champ grisé sans explication se lit comme
un défaut ; celui-ci expose une décision.

**Aucun secret n'y figure.** La clé maître est désignée par son empreinte
publique (§9.14) ; les secrets de jetons ne sont même pas nommés. Une console de
conformité n'est pas un endroit où l'on va chercher des secrets, et c'est testé.

**La consultation ne s'inscrit pas au journal**, comme la lecture du journal
lui-même (§9.11) : tracer chaque ouverture d'un écran de réglages noierait les
actes sous les regards. Ce sont les changements qui se traceront — ce lot n'en
permet aucun.

**Réserve** — le privilège voyage dans le jeton d'accès, comme le rôle : une
révocation prend effet à l'expiration de l'accès, quinze minutes par défaut.
C'est le même délai que pour la désactivation d'un compte aujourd'hui, et le
rendre immédiat demanderait de relire l'utilisateur en base à chaque requête —
un coût qu'on ne paiera que si un incident le justifie. Par ailleurs, une
instance sans aucun administrateur d'instance est une instance qu'on ne peut
plus régler sans accès au serveur : la commande le dit lorsqu'elle n'en trouve
aucun, mais rien n'empêche de révoquer le dernier. Un garde-fou viendra quand la
console permettra de révoquer, c'est-à-dire au lot des accès.

### 9.23 Renoncer à une preuve se décide, se motive et se rejoue (S6)

Le produit enregistrait tout ce que la capture lui déposait. Une politique
d'enregistrement sélectif dit ce qu'il faut enregistrer, et donc **ce à quoi
l'on renonce d'avance** : pour un produit dont toute la valeur est la preuve,
c'est un renversement. L'argument commercial est réel — enregistrer 20 % des
appels coûte cinq fois moins cher en stockage qu'enregistrer tout — mais il ne
tient que si chaque appel manquant peut être expliqué. Tout ce lot est écrit
pour cela.

**Une décision se motive.** Le moteur ne rend jamais un oui/non : il rend la
règle qui a tranché. « Cet appel n'est pas enregistré parce que la règle
"Médecine du travail" l'exclut, sous la version 7 de la politique » se défend
devant un contrôleur ; « cet appel n'est pas là » ne se défend pas.

**Une décision se rejoue.** L'échantillonnage est **déterministe** : la même
référence d'appel et la même règle donnent toujours le même tirage, que
quiconque peut recalculer des mois plus tard. Un tirage aléatoire aurait rendu
« pourquoi celui-là ? » sans réponse. Le hachage est un FNV-1a de dix lignes et
non SHA-256, pour trois raisons dans cet ordre : le moteur tourne dans le
navigateur, où `node:crypto` n'existe pas — vérifié, le portail refuse de se
construire ; il devra être réimplémenté dans le connecteur, en Lua ou en shell ;
et un contrôleur doit pouvoir refaire le calcul. La résistance cryptographique
n'était pas la propriété recherchée : un agent ne choisit pas la référence
d'appel, que le PBX attribue.

**Une décision se date.** Une version publiée est immuable — un déclencheur en
base l'y contraint, comme pour le journal d'audit (§5) — et numérotée. Ce numéro
voyagera avec chaque décision. Réécrire une politique publiée reviendrait à
réécrire la raison d'une absence de preuve.

**Les exclusions ne sont pas des règles.** RH, médecine du travail,
représentation du personnel : ces numéros sont évalués avant tout le reste, dans
une liste séparée. S'ils étaient des règles ordonnées, un administrateur qui
réordonne sa liste exposerait un jour la ligne de la médecine du travail — un
incident dont on ne se relève pas. L'ordre est donc : exclusions, puis règles
dans l'ordre écrit, puis défaut de la politique.

**Le défaut du produit enregistre tout.** Sans politique publiée, et quand
aucune règle ne correspond, tout est enregistré. Ne pas enregistrer doit
résulter d'une décision écrite, jamais d'un oubli de règle ou d'un référentiel
vide.

**Un seul moteur, dans le paquet partagé.** L'api valide avec, le portail
simule avec, le connecteur décidera avec. Trois implémentations auraient produit
trois lectures divergentes du même document, et l'écran aurait promis ce que la
téléphonie n'aurait pas fait. C'est aussi ce qui permet au simulateur d'être
autre chose qu'une aide à la saisie : il rejoue la décision réelle, sur le
brouillon avant publication.

**La durée de conservation reste hors de cette politique.** Elle décide **si**
l'on enregistre ; la rétention décide **combien de temps** (§9.6, et §9.10 qui a
prévu la déclinaison par catégorie). Deux sources de vérité pour la même
question finissent par diverger, et le jour où elles divergeraient, c'est la
purge qui arbitrerait.

**`POLICY_SET` s'ajoute au §5**, comme `RETENTION_SET` au §9.6. La publication
exige une note d'au moins dix caractères et porte au journal un indicateur
`renonce`, qui dit d'un coup d'œil si cette version abandonne des
enregistrements. Un brouillon, lui, ne trace rien : c'est un travail en cours
sans effet sur la capture, comme la simulation de purge du §9.7.

**Réserve** — ce lot construit le référentiel ; **rien ne l'applique encore**.
La politique sera publiée aux connecteurs (lot 05) puis appliquée à la source
(lot 06), et c'est seulement là qu'un appel cessera d'être enregistré. Tant que
ce n'est pas fait, une politique publiée est une intention, et l'écran ne doit
pas laisser croire l'inverse. Par ailleurs, `on_demand` et la pause pour saisie
sensible sont **déclarés** ici et exécutés par le connecteur : si un PBX ne sait
pas les tenir, la politique promettra plus que la capture ne fera — le lot 06
devra dire ce qu'un connecteur sait faire, et refuser de publier une politique
qu'il ne peut pas appliquer. Enfin, les listes de numéros s'écrivent une ligne à
la fois dans une zone de texte : robuste et copiable depuis un tableur, mais
pénible au-delà de quelques dizaines d'entrées ; l'import de fichier viendra si
le besoin se confirme.

### 9.24 Un écran de professionnel ne se justifie pas (S6)

Les écrans du portail expliquaient le produit à chaque champ : sous le défaut
d'une politique, pourquoi il enregistre tout ; sous une liste d'exclusion,
pourquoi elle prime ; sous chaque réglage d'instance, pourquoi il ne se modifie
pas ici. Chacun de ces paragraphes était juste, et l'ensemble alourdissait
l'outil au point de lui donner l'air de plaider sa cause.

**Ce que voit un utilisateur professionnel doit être court.** Un responsable
conformité qui ouvre l'écran des politiques pour la vingtième fois n'a pas
besoin qu'on lui rappelle la doctrine du produit ; il a besoin de trouver son
champ. Le raisonnement qui a présidé à un choix reste utile — mais une fois, pas
à chaque visite.

**Trois niveaux, désormais.** Le libellé dit quoi. L'icône d'aide (ⓘ), au
survol, dit l'essentiel en une phrase. `docs/manuel-utilisateur.md` porte le
développement complet, avec renvoi à la décision qui le fonde. Rien n'a été
perdu : ce qui a été retiré des écrans a été déplacé, et le manuel est le seul
document qui s'adresse à l'utilisateur plutôt qu'au développeur.

**Ce qui reste à l'écran malgré la règle**, parce que ce n'est pas de la
justification mais de l'information d'état ou de l'avertissement : que l'écoute
et l'export sont inscrits au journal (§9.4, §9.8) ; que le compte se verrouille
après plusieurs échecs ; que l'instance sert des données fabriquées (§9.21) ;
qu'aucune politique publiée signifie que tout est enregistré ; qu'un brouillon
est sans effet avant publication ; qu'un réglage est en lecture seule. Ces
mentions changent ce que l'utilisateur croit vrai de l'état du système, ou
l'avertissent d'une conséquence — les taire serait un dark-pattern, pas de la
sobriété.

**L'aide est accessible, pas seulement décorative.** L'icône porte le texte en
`aria-label` et en `title` : un lecteur d'écran l'annonce, et les tests
vérifient l'aide par son nom accessible plutôt que par un paragraphe visible.
Une infobulle qu'un clavier ne peut pas atteindre serait une régression
déguisée en épure.

**Réserve** — l'infobulle native (`title`) ne s'affiche pas au toucher et tarde
à la souris. Elle suffit pour une aide d'appoint sur un poste de travail, qui
est le cadre d'usage ; le jour où le portail sera consulté sur tablette, ou si
l'aide devient nécessaire à la compréhension plutôt qu'utile, il faudra un vrai
composant d'infobulle (clic, ancrage, fermeture au clavier) — et ce sera un lot,
pas une retouche. Par ailleurs, le manuel vit à côté du code : rien ne garantit
qu'il suive une évolution d'écran, sinon la discipline. Le jour où il divergera,
c'est lui qu'un utilisateur croira.
