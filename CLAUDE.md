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
sauvegarde de la base (lot 07 du S4) plutôt qu'à côté — une base restaurée sans sa
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
La politique sera publiée aux connecteurs (lot 06) puis appliquée à la source
(lot 07), et c'est seulement là qu'un appel cessera d'être enregistré. Tant que
ce n'est pas fait, une politique publiée est une intention, et l'écran ne doit
pas laisser croire l'inverse. Par ailleurs, `on_demand` et la pause pour saisie
sensible sont **déclarés** ici et exécutés par le connecteur : si un PBX ne sait
pas les tenir, la politique promettra plus que la capture ne fera — le lot 07
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

### 9.25 Une seule façon de naviguer (S6)

La barre horizontale portait cinq entrées et devait en accueillir une dizaine :
comptes, conservation, sources, sauvegarde, locataires, politiques.

Un menu latéral avait d'abord été essayé pour les écrans de réglages. Il a été
retiré : il faisait cohabiter **deux façons de naviguer** selon l'écran où l'on
se trouvait — des onglets ici, une colonne là — et serrait le contenu de pages
qui n'en avaient pas besoin. Une interface professionnelle se parcourt d'une
seule manière.

**Un onglet sans sous-section est un lien ; un onglet qui en a s'ouvre au
clic**, par-dessus le contenu. C'est le modèle d'une barre de menu ordinaire, et
il vaut pour toute l'interface : rien à réapprendre en passant d'un écran à
l'autre, et le déroulant ne prend de place que le temps qu'on le lit.

**Au clic, pas au survol.** Un menu qui s'ouvre au passage de la souris s'ouvre
aussi quand on ne le voulait pas, et n'existe pas au doigt. Il se referme à
Échap, au clic ailleurs et après navigation — un menu resté ouvert derrière
l'écran suivant finit par être cliqué par mégarde.

**Accessible, et pas seulement cliquable.** Le modèle retenu est celui d'un
« disclosure » de navigation : un bouton qui déclare ce qu'il commande
(`aria-expanded`, `aria-controls`) et des liens ordinaires. Pas de `role="menu"`,
qui obligerait à gérer les flèches sans rien apporter à une navigation. Les
tests vérifient l'ouverture au clavier et l'ordre de tabulation.

**Sur petit écran, les entrées passent à la ligne** plutôt que de défiler : un
conteneur qui défile coupe ce qui en déborde, et couperait donc le déroulant
lui-même.

**Seules les entrées qui existent sont affichées**, et un onglet dont aucune
entrée n'est accessible disparaît au lieu de s'ouvrir sur rien. Les sections se
rempliront lot par lot. Les URL, elles, ne changent pas : le runbook et le
manuel y renvoient, et une réorganisation de menu n'est pas une raison de casser
des liens écrits ailleurs.

Les libellés de boutons suivent la même exigence de banalité : « Créer »,
« Modifier », « Publier », « Supprimer », « Désactiver ». « Commencer une
politique » et « Abandonner » disaient la chose juste dans une langue que
personne n'attend d'un logiciel de gestion.

**Réserve** — l'infobulle et le déroulant reposent sur le clic et le clavier,
ce qui couvre le poste de travail et le tactile. Reste qu'un déroulant à quatre
sections sur un écran de téléphone sera long à parcourir : le jour où le portail
sera réellement consulté sur mobile, il faudra un repli complet de la barre
(bouton unique, panneau plein écran) — ce sera un lot, pas une retouche.

### 9.26 Un compte se crée, se désactive, et ne se devine pas (S6)

Deuxième lot de la console. Donner à quelqu'un le droit d'entendre des
conversations de clients est l'acte le plus lourd qu'on y accomplisse : il se
trace, il ne s'auto-attribue pas, et il ne doit jamais fermer la porte derrière
lui.

**Un compte ne se supprime pas, il se désactive.** Le journal d'audit référence
son auteur (`onDelete: Restrict`, §5) : l'effacer effacerait le lien vers ce
qu'il a écouté. La console n'offre donc aucune suppression, et un compte
désactivé ne peut plus se connecter tout en restant nommable dans le journal.

**Le mot de passe initial est provisoire et l'api l'impose.** Il est engendré
par le produit — jamais choisi par l'administrateur, qui prendrait le premier
qui lui vient et le retrouverait dans un courriel six mois plus tard — rendu
**une seule fois**, et à renouveler dès la première connexion. Tant qu'il ne
l'est pas, un garde global ne laisse passer que le profil, le changement de mot
de passe et la déconnexion : masquer le portail n'aurait rien protégé, l'api
restant joignable directement.

Il est écrit pour être dicté au téléphone : quatre groupes de quatre
caractères, sans `O` ni `0`, sans `I` ni `1`. Le changer rend une paire de
jetons neuve — le drapeau voyage dans le jeton — et révoque les sessions
ouvertes ailleurs, parce que changer son mot de passe est le geste de qui craint
qu'on le lui ait pris.

**Pas d'expiration périodique.** C'est un choix, et il surprendra peut-être un
responsable conformité habitué à la règle des quatre-vingt-dix jours : imposer
un changement régulier produit `Banque2026!1` puis `Banque2026!2`, et des
pense-bêtes sous les claviers. Les recommandations actuelles l'ont abandonnée.
Ce qui protège est ailleurs, et déjà en place : longueur sérieuse, refus de ce
qui se devine — suites courantes, adresse du titulaire, trop peu de caractères
distincts — verrouillage après échecs (§5) et limitation par adresse (§9.16).

**Un administrateur ne modifie pas son propre compte.** Se rétrograder ou se
désactiver soi-même, c'est se fermer la porte de l'intérieur, et il faudrait
alors un accès au serveur pour revenir. Un autre administrateur le fait.

**Le dernier administrateur de l'instance est protégé** — la réserve du §9.22
est levée. Ni la console ni la commande d'exploitation ne le laissent
rétrograder, désactiver ou révoquer tant qu'aucun autre ne le remplace : sans
lui, la console d'administration se ferme à tout le monde.

**`USER_SET` s'ajoute au §5**, avec l'avant et l'après de chaque changement.
C'est la troisième action ajoutée après `RETENTION_SET` (§9.6) et `POLICY_SET`
(§9.23), et pour la même raison : ce qui engage la banque doit se lire au
journal.

**Réserve** — l'unicité de l'adresse est globale (§9.1) : créer un compte dont
l'adresse existe déjà chez un autre locataire est refusé, et le refus révèle,
par déduction, que cette adresse est connue de l'instance. On ne dit pas où, et
c'est le mieux qu'on puisse faire sans renoncer à l'unicité globale ; le jour où
l'offre mutualisée du §9.1 arrivera, ce cas disparaîtra avec elle. Par ailleurs,
le mot de passe provisoire circule aujourd'hui de la main à la main : c'est
acceptable pour un service conformité de quelques personnes, et cela demandera
un envoi par courriel — donc le SMTP du lot 05 — dès qu'un client aura des
dizaines de comptes à ouvrir.

### 9.27 L'heure d'un journal n'est pas une affaire de réglage serveur (S6)

Signalé depuis la démonstration : le journal d'audit affichait une heure de
trop. Le diagnostic a montré autre chose qu'un défaut d'affichage — le portail
formate correctement en Africa/Douala. C'est **ce qui est écrit** qui était
faux.

**Le mécanisme.** Les colonnes d'horodatage sont des `timestamp` **sans
fuseau**, et celles qui portent `DEFAULT CURRENT_TIMESTAMP` — `audit_events.at`
et tous les `created_at` — prennent la valeur du fuseau de la **session**. Une
base réglée sur Africa/Douala y écrit 13 h 56 quand il est 12 h 56 UTC. L'api
relit cette colonne comme de l'UTC, le portail la convertit en heure de Douala,
et affiche 14 h 56. Une heure de trop, dans un journal append-only qu'aucune
route ne peut corriger.

Pire : les dates posées par l'application (`publishedAt`, `startedAt`) restaient
justes. Deux familles d'horodatages divergeaient donc **à l'intérieur de la même
base**, et un enregistrement paraissait créé une heure après l'appel qu'il
décrit.

**Le produit impose le fuseau à sa connexion**, plutôt que de s'en remettre au
serveur : l'url porte `options=-c timezone=UTC`. Trois raisons. Un client
fournira sa propre base, dont le réglage ne nous regarde pas. Le fuseau est figé
dans `postgresql.conf` **à l'initialisation du volume** — corriger la variable
d'environnement d'un compose ne change donc rien à une base déjà créée, ce qui
rend toute consigne d'exploitation illusoire. Et l'api n'a pas à savoir dans
quel pays tourne sa base : elle écrit en UTC, l'affichage convertit.

**Un contrôle au démarrage refuse une session qui n'est pas en UTC**, comme la
validation d'environnement du §2 refuse un secret d'exemple. Mieux vaut ne pas
démarrer qu'écrire des horodatages faux dans un journal qu'on ne pourra pas
corriger.

**Deux pièges rencontrés en chemin**, tous deux attrapés par les tests.
`URLSearchParams` encode l'espace en `+`, que libpq lit littéralement : `pg_dump`
refusait de se connecter sur « unrecognized configuration parameter
"+timezone" ». Le paramètre est donc écrit à la main en `%20`, et retiré de
l'url passée aux outils PostgreSQL, qui n'ont que faire du fuseau de session.

**Réserve** — les horodatages déjà écrits restent décalés : ils ne se corrigent
pas, précisément parce que le journal est append-only. Sur une instance
d'évaluation, la réponse est de regarnir ; sur une instance en service, il
faudra dater la correction et savoir que les entrées antérieures portent le
décalage — c'est une raison de plus pour que ce contrôle existe avant le premier
pilote. Par ailleurs, la vraie solution de fond serait des colonnes
`timestamptz`, qui ne dépendent d'aucune session : c'est une migration lourde
sur des tables dont l'une est protégée en écriture, à envisager si un autre
symptôme du même genre apparaît.

### 9.28 La conservation se décline par catégorie, et la plus précise l'emporte (S6)

Le §9.10 avait posé `Recording.operationCategory` en annonçant qu'elle
porterait un jour des durées différenciées, et laissé deux points à trancher.
Les voici tranchés.

**La politique la plus précise l'emporte, et non la plus longue.** La réserve
du §9.10 penchait pour la plus longue, « puisqu'en conservation c'est le doute
qui doit profiter à la preuve ». À l'écriture, cette règle s'est révélée
contraire à l'usage : elle rendrait toute politique de catégorie incapable de
raccourcir, donc inutile dans le cas réel — conserver dix ans les ordres de
change et un an les appels internes suppose de pouvoir faire les deux, et c'est
l'argument économique du produit.

Ce qui protège contre un raccourcissement discret n'est pas cette règle : c'est
le **plancher de l'instance**, qui exige un motif écrit sous son seuil et
l'inscrit au journal (§9.6). Il s'applique à chaque politique, générale comme
catégorielle. Le doute profite donc toujours à la preuve, mais par un garde-fou
qui se lit plutôt que par une règle de priorité qu'on découvrirait à
l'exécution.

**Une catégorie sans politique propre suit la générale**, et l'écran le dit
plutôt que d'afficher un vide. La réponse porte pour chaque catégorie sa durée
effective **et** l'information de savoir si elle est enregistrée : sans quoi on
ne distinguerait pas « décidé à 730 » de « hérité de 730 ».

**Le rapport de purge fige toutes les durées, pas une seule.** `PurgeRun`
portait `policyDays` et un `cutoff` uniques ; il faut désormais une échéance par
périmètre. `policyDocument` les enregistre, et l'exécution **rejoue ce
document** — jamais les durées du jour. C'est la règle du §9.7 étendue : ce qui
a été autorisé doit être exactement ce qui est détruit, et un rapport devient
inexécutable dès qu'une seule durée a bougé.

Le refus le dit en français — « catégorie operation_change suit la générale →
3650 jours » — et non en JSON : un exploitant lit un message, pas une structure
de données.

**Le second point du §9.10 reste sans objet.** « Ce qu'il advient d'un appel
dont la catégorie change après coup » ne se pose pas : la catégorie vient du
producteur à l'ingestion, et aucune route ne la modifie. Le jour où un écran le
permettrait, il faudra décider si l'échéance se recalcule — et la réponse sera
probablement non pour un appel déjà purgeable, sous peine de rendre la purge
dépendante d'une saisie.

**Réserve** — le catalogue de catégories reste la liste fixe du contrat §3. La
table `OperationCategory` par locataire, annoncée au §9.10, reste à faire ; tant
qu'elle n'existe pas, une banque ne peut pas déclarer ses propres catégories, et
donc pas ses propres durées. Par ailleurs, le premier filtre de recensement
retient la borne la plus lointaine puis affine appel par appel : correct, mais
il lit plus de lignes que nécessaire quand une catégorie conserve dix ans et les
autres un an. Sur les volumes visés c'est sans conséquence ; au-delà, ce sera un
recensement par catégorie plutôt qu'un filtrage après coup.

### 9.29 Une conservation forcée se pose sur pièce et se lève à quatre yeux (S6)

Poser une conservation forcée protège une preuve ; la lever la rend
destructible. Le §9.6 traitait les deux actes de la même façon — un motif
écrit — alors qu'ils n'engagent pas également.

**La référence du dossier est exigée à la pose**, en plus du motif.
« Réquisition judiciaire » dit ce qu'on fait ; « n° 2026-118 du parquet de
Douala » dit de quoi on parle, et c'est cette seconde information qu'un
contrôleur demandera. Elle est libre — chaque banque numérote ses dossiers à sa
façon — et inscrite au journal avec le motif, pour que la trace se lise sans
autre source.

**La levée demande un second administrateur.** Celui qui a posé ne peut pas
lever : défaire seul ce qu'on a seul décidé rendrait la conservation aussi
solide que la volonté d'une personne. Un administrateur **désactivé** ne compte
pas comme second — c'est le contournement le plus évident, et il est testé.

**L'exception est assumée, en deux temps.** Une instance qui n'a qu'un
administrateur actif ne peut pas se retrouver dans l'impossibilité de lever une
conservation devenue sans objet. La levée est alors d'abord **refusée**, avec un
message qui explique la situation ; elle passe si l'appelant l'assume
explicitement, et le journal porte « levée sans contre-validation ». Empêcher
aurait créé un blocage sans issue ; laisser passer en silence aurait effacé la
différence entre deux niveaux de garantie. Le fait est aussi retenu sur la
ligne, pour qu'on puisse le retrouver sans relire le journal.

**Un appel protégé n'est jamais candidat à la purge**, quelle que soit son
ancienneté, et n'est jamais détruit : deux tests le vérifient sur un appel de
cinq ans sous une conservation de deux. La section « épargnés » du rapport
demeure — c'est la décision du §9.7, et un auditeur veut voir ce qui a échappé
à la purge et pourquoi.

**Réserve** — le quorum est de deux administrateurs *du locataire*, sans
distinguer celui qui a posé de celui qui contre-valide en pratique : rien
n'empêche deux personnes de s'entendre. C'est le propre de toute règle à quatre
yeux, et ce qui la rend utile n'est pas l'impossibilité de la contourner mais le
fait que le contournement laisse deux noms au journal au lieu d'un.

### 9.30 Deux planchers, et une migration qui s'éprouve sur une base peuplée (S6)

**Le plancher d'instance et le plancher réglementaire ne disent pas la même
chose.** Le premier (`RETENTION_MIN_DAYS`) est une règle de maison : on descend
en dessous avec un motif écrit, et le journal en garde trace (§9.6). Le second
(`RETENTION_REGULATORY_FLOORS`, par catégorie) se veut l'écho d'une obligation
extérieure : **il ne se déroge pas**. Une durée inférieure est refusée, motif ou
non, avec le message « en dessous du minimum réglementaire de N jours ».

**Il vaut zéro par défaut**, et c'est la seule position tenable : tant que la
cote de texte n'est pas établie (§9.9), le produit ne fait pas semblant de
connaître une durée légale. C'est l'exploitant qui déclare ce qu'il sait, en
connaissance de cause — et une déclaration mal formée empêche le démarrage,
comme un secret d'exemple non remplacé (§2) : un plancher qu'on croit posé et
qui ne l'est pas est pire que pas de plancher du tout.

**L'écran annonce le minimum avant la saisie**, et distingue une durée
**décidée** d'une durée **héritée** : sans cette distinction, on ne saurait pas
si 730 jours résultent d'un choix ou d'un défaut.

**Une migration s'éprouve désormais sur une base peuplée.**
`scripts/migrate-check.sh` restaure un dump d'instance — ou, à défaut, fabrique
une base en retard d'une migration puis y insère une ligne dans chaque table
qu'une migration risque de contraindre — avant d'appliquer ce qui reste. Il
tourne en CI.

La règle vient d'un défaut réel : `ADD COLUMN case_reference TEXT NOT NULL` sans
défaut passait sur une base vide et aurait refusé de s'appliquer sur une base
contenant déjà des conservations forcées, laissant l'api refuser de démarrer
chez le client. Le script a été vérifié dans les deux sens — il accepte la
migration corrigée et rejette celle d'origine.

**Réserve** — le mode sans dump peuple les tables que nous connaissons
aujourd'hui ; une migration qui contraindrait une table oubliée du jeu passerait
sans être éprouvée. Le mode `--dump`, lui, ne dépend d'aucune liste : c'est
celui qu'il faut employer avant une mise en service, et il suppose un dump
récent de l'instance visée.

### 9.31 Le certificat de destruction, pièce qui survit à ce qu'elle décrit (S6)

Le §9.7 avait posé ce qui reste d'un appel purgé : sa fiche, son empreinte, sa
trace au journal. Le certificat rassemble ces restes en une pièce unique, que la
banque range dans son dossier de conformité. Un contrôleur ne demandera pas
« montrez-moi la base » : il demandera « qu'avez-vous détruit, quand, au nom de
quoi, et sur l'ordre de qui ? ».

**Il se construit depuis le rapport, jamais depuis les enregistrements.** Ceux
qui ont été détruits n'ont plus de fichier, et leurs lignes pourraient un jour
disparaître à leur tour. `PurgeRunItem` porte donc désormais la catégorie et la
**durée appliquée** : le certificat doit pouvoir dire au nom de quelle
conservation chaque pièce est tombée, et l'enregistrement n'a plus rien pour en
témoigner.

**Son empreinte porte sur le contenu, pas sur le fichier.** Le PDF et le CSV du
même rapport rendent la même valeur, obtenue d'une sérialisation aux clés
triées : deux constructions du même certificat doivent donner deux fois la même
empreinte, sans quoi la vérification ne prouverait rien. Elle est **figée à
l'instant de la destruction**, non au premier téléchargement — un certificat
délivré des mois plus tard doit porter la valeur de ce jour-là.

**Deux formats, deux usages.** Le PDF se range dans un dossier et se présente ;
le CSV se recoupe avec un inventaire, dans la forme qu'attend un tableur
français (§9.11). Chaque téléchargement s'inscrit au journal comme un `EXPORT`,
avec le format et l'empreinte : un certificat qui sort du produit devient une
pièce autonome qui circulera.

**Il n'existe pas pour une destruction qui n'a pas eu lieu.** Un rapport encore
simulé n'ouvre aucun certificat : en délivrer un serait un faux.

**Il est ouvert aux trois rôles.** C'est une pièce de conformité et non un acte,
elle ne contient aucun audio, et un auditeur doit pouvoir la produire sans
passer par l'exploitant.

**Réserve** — le certificat n'est pas signé. Son empreinte prouve qu'il n'a pas
changé depuis sa délivrance **à qui peut la comparer au journal** ; elle ne
prouve rien à un tiers qui recevrait le seul PDF. Une signature électronique le
rendrait opposable hors du produit, et c'est ce qu'il faudra faire le jour où un
certificat devra être remis à un tiers plutôt que présenté depuis le portail —
la même réserve que celle du §9.8 sur l'archive d'export. Par ailleurs, le motif
de destruction est relu depuis le premier `PURGE` du rapport : si le journal
était un jour purgé de ses plus vieilles entrées — ce qu'aucune route ne permet
aujourd'hui — le certificat perdrait cette mention.

### 9.32 Les écrans de conformité, et ce qu'ils refusent de laisser deviner (S6)

Dernier sous-lot du lot 03. Les trois mécanismes du S4 — conservation, hold,
purge — n'existaient qu'en api et en ligne de commande ; ils ont désormais leurs
écrans. Une décision les gouverne tous : **un écran de conformité ne doit jamais
en dire moins que ce que le produit sait.**

**Une durée dit d'où elle vient.** Chaque périmètre porte « décidée le … » ou
« héritée » — de la générale pour une catégorie, du défaut produit pour la
générale. Sans cette mention, 730 jours à l'écran ne permettent pas de
distinguer un choix d'un défaut, et un contrôleur qui demande « qui a décidé
cela ? » n'obtient rien.

**Les deux planchers ne se présentent pas de la même façon**, parce qu'ils ne
s'opposent pas de la même façon (§9.6, §9.30). Le plancher d'instance et le
minimum réglementaire s'affichent ensemble, en lecture seule, avec la mention
« fixé par Atlastech » : ce sont des garanties posées au déploiement, pas des
réglages client. Le champ de motif de dérogation n'apparaît **que** sous le
plancher d'instance — le faire apparaître au-dessus transformerait la prudence
en corvée, et un motif accroché à une politique qui ne déroge à rien ferait
croire à une dérogation qu'il n'y a pas.

**Un rapport de purge annonce toutes ses durées, pas la générale seule.**
`PurgeReportSummary` gagne `policyByScope` et `PurgeReportItem` gagne la
catégorie et la durée qui l'a jugé. Sans cela, un rapport où les ordres de
change relèvent de dix ans et le reste de deux s'affichait comme un rapport à
deux ans : l'écran aurait présenté une purge autrement qu'elle n'a eu lieu. Ces
deux champs d'item sont **nullables** — un rapport établi avant le §9.31 ne les
porte pas, et on ne lui invente pas une catégorie.

**La fiche d'appel annonce la mesure même quand son détail échoue.** Le portail
sait par la liste qu'un appel est sous conservation forcée ; il charge ensuite
l'historique pour en dire le motif, le dossier, l'auteur et la date. Si ce
second appel échoue, le bandeau reste et dit que le détail n'a pas pu être
chargé — plutôt que de disparaître et de faire lire un appel ordinaire là où une
mesure court. Un historique manquant n'est pas un historique vide.

**La levée en deux temps est portée par l'écran, pas seulement par l'api.** Le
refus « aucun autre administrateur actif » n'est pas un échec : c'est une
demande d'assumer. L'écran transforme donc ce refus en un second bouton,
« Lever sans contre-validation », et annonce la mention qui sera consignée. Le
laisser sous forme de message d'erreur aurait obligé l'exploitant à deviner
qu'il fallait recommencer autrement.

**Le certificat n'apparaît que sur un rapport exécuté** (§9.31), et son
empreinte s'affiche à côté des deux boutons : c'est la valeur qu'on recopie pour
vérifier la pièce plus tard.

**L'onglet Administration s'ouvre désormais à l'auditeur**, sur la seule section
« Conformité ». C'est une conséquence assumée de §9.28 et §9.7 : lire les durées
de conservation et les rapports de purge fait partie de son métier. Les comptes
et les réglages d'instance lui restent fermés, et deux tests qui affirmaient
« aucun onglet d'administration pour un auditeur » disent maintenant ce qui
compte vraiment — quelles entrées il n'y trouve pas.

**Réserve** — les lignes d'un rapport sont paginées par l'api mais l'écran n'en
affiche que la première page : au-delà de vingt-cinq appels, il faut télécharger
le certificat pour tout lire. C'est acceptable tant que la purge reste un acte
rare sur des volumes modestes ; le jour où un rapport comptera des milliers de
lignes, il faudra une pagination à l'écran — et probablement un filtre par
catégorie, puisque c'est elle qui décide de l'échéance. Par ailleurs l'écran
recharge l'historique des conservations à chaque ouverture de fiche : une requête
de plus par consultation, sans conséquence ici, à revoir si la fiche devait
s'ouvrir en liste.

### 9.33 Une comparaison de preuves ne passe pas par une sérialisation (S6)

Défaut trouvé à la recette du lot 03 sur l'instance d'évaluation : sur un
rapport de purge établi et exécuté dans la foulée, sans qu'aucune durée n'ait
bougé, l'exécution était refusée — « La conservation est passée à ␣ depuis ce
rapport ». Le garde-fou du §9.7, celui qui protège l'autorisation, se
déclenchait à faux et rendait la purge inexécutable.

**La cause est une comparaison de chaînes là où il fallait comparer des
valeurs.** `PurgeRun.policyDocument` est une colonne `jsonb`, et PostgreSQL y
range les clés par longueur puis par octet : ce qui est écrit `all,
confirmation_cheque, operation_change` revient `all, operation_change,
confirmation_cheque`. Confronter deux `JSON.stringify` refusait donc tout
rapport portant deux durées de catégorie ou plus. La comparaison porte
désormais sur le contenu — ensemble des périmètres, valeur de chacun.

**Le message vide était le symptôme, pas un second défaut.** L'interpolation
manquait parce que la fonction qui décrit l'écart ne trouvait, à juste titre,
aucun écart à décrire. Un refus dont la raison sort vide est le signe qu'il
n'aurait pas dû être prononcé ; c'est ce qui a désigné la cause.

**Trois défauts voisins ont été trouvés en réparant celui-là**, tous de la même
famille — le produit en disait moins que ce qu'il savait.

`PurgeRun.executionReason` — le certificat relisait le motif de destruction
depuis le premier `PURGE` du journal. Une purge qui ne détruit rien n'écrit
aucun `PURGE` : le certificat annonçait « motif non consigné » alors qu'un
motif avait bien été saisi. Le motif est désormais retenu sur le rapport, et le
journal n'est plus qu'un recours pour les rapports antérieurs. La réserve du
§9.31 sur ce point tombe.

La réponse de l'exécution annonçait `certificateSha256: null` : elle était
construite sur la ligne lue **avant** que l'empreinte du certificat n'y soit
écrite. L'appelant croyait n'avoir aucun certificat au moment même où il venait
d'être scellé.

**L'empreinte servie au téléchargement est celle scellée à la destruction**, et
non celle qu'on recalcule. Elles doivent coïncider ; si une évolution du
produit change ce que le certificat énonce, elles cessent de coïncider, et le
produit le dit — en-tête `X-Certificat-Reproduit`, avertissement à l'écran,
écart consigné au journal avec les deux valeurs. C'est le principe du §9.8
appliqué au certificat : on ne substitue pas une valeur à l'autre en silence.
L'avertissement ne peut pas figurer *dans* la pièce, contrairement au §9.8 :
l'y écrire changerait le contenu, donc l'empreinte, et la vérification
tournerait en rond.

**Une purge qui ne trouve rien à détruire reste un acte, et se certifie.** Un
exploitant a ordonné une destruction sur un rapport qui n'énumérait rien : le
certificat l'atteste, daté, attribué, motivé, et sa mention dit « n'a détruit
aucune pièce » plutôt que d'affirmer que « les enregistrements ci-dessus ont
été détruits » au-dessus d'une liste vide. Refuser le certificat aurait fait
dépendre son existence du *résultat* plutôt que de l'*acte*, et laissé sans
réponse écrite la question « qu'a détruit la purge du 5 septembre ? ».

**Réserve** — la même fragilité dort ailleurs : `PolicyService` calcule
l'empreinte d'une politique par `JSON.stringify` d'un document relu en `jsonb`.
Elle est aujourd'hui cohérente, les deux côtés de la comparaison passant par la
base ; elle ne le resterait pas si un connecteur recalculait l'empreinte depuis
le json qu'il reçoit, ce que le §9.23 prévoit. Ce sera à traiter au **lot 06** (publication aux
connecteurs), par une sérialisation canonique comme celle du
certificat — et non par une retouche discrète, puisqu'elle changerait les
empreintes déjà publiées. Par ailleurs, l'écran de conservation vide le champ
de motif après enregistrement d'une dérogation alors que la durée reste sous le
plancher : le refus de l'api protège, mais l'écran invite à un second envoi
incomplet. À corriger au prochain passage sur cet écran. Enfin, la mention du
certificat à zéro pièce enchaînait sur « Leurs empreintes, tailles et dates
subsistent… », dont le « leurs » ne renvoyait à rien : les deux cas ont
désormais leur mention entière plutôt qu'un tronc commun — corrigé au §9.34.

### 9.34 Ce qui n'est pas au journal n'a pas eu lieu (S6)

Second défaut bloquant de la recette du lot 03. Un rapport de purge établi puis
exécuté ne laissait **aucun** événement au journal d'audit — ni à
l'établissement, ni à l'exécution, ni à l'annulation. Seuls les téléchargements
de certificat apparaissaient.

**Une partie était une décision, l'autre un trou.** Le §9.7 avait tranché que
la simulation ne s'inscrit pas — « le `PurgeRun` est lui-même la trace », et un
`PURGE_SIMULATED` « aurait dédoublé cette trace sans rien apprendre à
personne ». L'exécution, elle, était censée s'inscrire : un `PURGE` **par
enregistrement détruit**. Une purge qui ne détruit rien n'en écrivait donc
aucun, et l'empreinte du certificat — que le §9.31 fait pourtant naître à
l'instant de la destruction — n'existait alors nulle part hors de la colonne
qui la porte.

**Le §9.7 est amendé.** L'argument de 2026 supposait qu'un lecteur du journal
irait consulter les rapports ; la recette a montré l'inverse. Un contrôleur lit
le journal, et c'est là qu'il pose sa question : « qu'avez-vous détruit, quand,
sur l'ordre de qui ? ». Un `PurgeRun` en base n'est pas une réponse s'il faut
d'abord savoir qu'il existe. Trois actions s'ajoutent au §5 —
`PURGE_SIMULATED`, `PURGE_EXECUTED`, `PURGE_CANCELLED` — après
`RETENTION_SET` (§9.6), `POLICY_SET` (§9.23) et `USER_SET` (§9.26), et pour la
même raison : ce qui engage la banque se lit au journal.

Le `PURGE` par enregistrement demeure : il porte l'empreinte de chaque pièce
détruite, ce qu'un événement de rapport ne saurait dire ligne à ligne. Les deux
ne font pas double emploi — l'un dit l'acte, l'autre dit les pièces.

**L'exécution et sa trace tiennent ou tombent ensemble.** Le passage du rapport
à « exécuté », le sceau de l'empreinte du certificat et l'inscription au
journal sont dans une même transaction. Une purge exécutée dont le journal ne
porterait rien serait une destruction sans trace lisible ; un rapport « exécuté »
sans empreinte scellée serait un certificat qu'on ne peut plus vérifier. C'est
testé en faisant échouer l'écriture au journal : le rapport reste « simulé ».

**`AuditService` gagne un mode transactionnel plutôt qu'un second chemin.**
L'écriture sans transaction reste au mieux — l'acte de l'utilisateur a déjà eu
lieu, et une trace perdue se remonte bruyamment plutôt que de le faire échouer
après coup. Avec une transaction, l'échec la fait échouer. Deux régimes, une
seule porte : `auditEvent.create` hors d'`AuditService` est désormais interdit
par un test qui relit les sources. La question posée à la recette — « un seul
mécanisme, pas deux » — se vérifie donc au lieu de se promettre.

**La destruction consigne deux incidents distincts**, qu'un premier jet
confondait : un fichier déjà absent du coffre compte comme détruit
(`fichiersDejaAbsents`, §9.7), tandis qu'une pièce qu'on n'a pas pu traiter du
tout — ligne disparue, chemin hors du coffre — ne compte pas (`nonTraites`).
Les additionner aurait fait dire au journal qu'on avait détruit ce qu'on
n'avait pas touché.

**Réserve** — les `PURGE` par enregistrement restent écrits hors transaction,
pendant la boucle de destruction : un arrêt brutal en cours de purge laisserait
des fichiers détruits, leurs `PURGE` inscrits, et le rapport encore « simulé ».
Le journal dirait alors la vérité et le rapport non — c'est le bon sens de
l'écart, mais il demandera une reprise : rejouer un tel rapport doit constater
ce qui a déjà disparu plutôt que de s'en étonner. Englober la boucle dans la
transaction n'est pas la réponse — on n'ouvre pas une transaction de base le
temps d'effacer des fichiers.

### 9.35 L'ordre des lots du S6 suit ce qui peut s'éprouver (S6)

Renumérotation décidée après la clôture du lot 03, et inscrite ici parce que
plusieurs réserves des §9.23, §9.26 et §9.33 renvoient à des numéros de lot.

| Lot | Objet |
| --- | --- |
| 01 | Socle de la console, privilège d'administrateur d'instance (§9.22) |
| 02 | Accès : comptes, mots de passe provisoires (§9.26) |
| 03 | Conformité : conservation, holds, purge, certificat (§9.28 à §9.34) |
| 04 | Politiques d'enregistrement sélectif — référentiel (§9.23) |
| **05** | **Réglages Réseau, Annuaire, Supervision, et état de l'instance** |
| 06 | Publication des politiques aux connecteurs |
| 07 | Application des politiques à la source |
| 08 | Sources de capture |
| 09 | Exploitation et sauvegarde |
| 10 | Multi-locataire |
| 11 | Général |

**Le motif est ce qui peut être éprouvé, et non ce qui vient logiquement
après.** L'annuaire et la supervision sont des prérequis d'un pilote bancaire —
une DSI ne déploie pas un outil dont les comptes vivent à part de son AD, ni
qu'aucune supervision ne surveille — et l'un comme l'autre se testent dès
aujourd'hui sur l'instance d'évaluation. La publication des politiques aux
connecteurs, elle, ne peut être éprouvée qu'une fois la capture réelle en place
(S5, FreeSWITCH ou CUCM) : la livrer avant reviendrait à écrire du code que
personne ne peut mettre en défaut, ce que le §9.23 reprochait déjà à une
politique publiée que rien n'applique.

**Conséquence à ne pas manquer** : le lot 05 est le premier à toucher à
l'authentification depuis le §9.26. La règle du dernier administrateur y est
étendue — il devra toujours rester un administrateur **local** actif, sans quoi
un annuaire injoignable fermerait la console à tout le monde.

**Réserve** — cette table vieillira dès que l'ordre bougera de nouveau. Elle
n'existe que parce que des réserves renvoient à des numéros ; le jour où un lot
sera renuméroté sans qu'elle le soit, c'est elle qu'on croira.

### 9.36 Les réglages d'instance : une table, un chiffrement dérivé, un journal (S6)

Socle du lot 05. Décisions arrêtées avant tout code, et qui valent pour les
quatre sous-lots.

**Une table clé/valeur au niveau instance, `instance_settings`.** La clé *est*
l'identifiant — jamais deux valeurs concurrentes pour un même réglage — et la
valeur est un **JSON par section**, non par champ : `reseau.ntp` porte ses trois
serveurs d'un bloc. Une section se lit, s'écrit et se journalise entière, ce qui
donne au journal un avant/après cohérent que des clés éparses ne donneraient
pas. La contrepartie est assumée : deux administrateurs modifiant la même
section s'écraseraient, et c'est le `version` qui l'empêche — l'écriture porte
la version lue et l'api la refuse si elle a bougé, comme l'empreinte d'un
rapport de purge refuse une exécution sur un ensemble qui a changé (§9.7).

**La valeur par défaut vit dans le code, jamais dans une ligne.** Une table vide
est une instance qui fonctionne, et le seed n'y insère rien. Une ligne absente
et une ligne à `null` ne disent pas la même chose : « jamais réglé » et « réglé
à rien ».

**Les secrets sont chiffrés sous une clé dérivée, pas sous la clé maître.**
Chaque secret vit dans le JSON de sa section sous la forme `{chiffre: "…"}`,
chiffré avec une clé tirée en HKDF de la clé maître sous le contexte
`voxecho-record:reglages:v1` — le motif du §9.13 pour les clés par fichier et du
§9.14 pour l'empreinte publique. Employer la clé maître directement aurait lié
deux sujets qui n'ont pas à l'être : une rotation de clé de coffre (non
outillée, §9.13) aurait rendu du même coup l'annuaire injoignable et la
supervision muette. Conséquence assumée : `STORAGE_MASTER_KEY` devient
nécessaire dès qu'un secret de réglage est saisi, même sur une instance qui ne
scelle pas son stockage — l'api le dit au démarrage plutôt qu'à la première
saisie.

L'api ne rend **jamais** un secret : `********` en lecture, et un champ
« remplacer » explicite en écriture. Un champ de mot de passe pré-rempli d'une
valeur masquée est un piège — on le renvoie tel quel sans le vouloir.

**`SETTINGS_SET` et `SETTINGS_TEST` s'ajoutent au §5**, écrits par le seul
chemin du §9.34. La trace porte la clé, les versions et les valeurs avant/après.
Un secret y figure `********` **des deux côtés**, accompagné d'un booléen
`secretRemplace` : sans lui, deux masques identiques ne diraient pas si le
secret a changé. Le test d'un réglage se journalise **en échec comme en
succès** — un test qui ne laisserait trace que lorsqu'il réussit ne servirait
qu'à se rassurer.

**`TRUSTED_PROXIES` : l'environnement l'emporte sur la base.** Le §9.22
l'exposait en lecture seule ; il devient modifiable, mais la variable
d'environnement, si elle est renseignée, gagne. C'est un réglage
d'infrastructure lié au relais réellement installé : si la base pouvait le
surcharger, un administrateur fausserait depuis l'interface l'adresse inscrite
au journal d'audit, exactement le défaut que le §9.16 a corrigé. L'onglet dit
laquelle des deux sources est en vigueur.

**Le mode de déploiement se lit dans `VOXECHO_DEPLOY_MODE`** (`cloud` par
défaut, `onprem`). Une section on-prem masquée en cloud est remplacée par une
ligne qui dit qui rend le service — jamais par un vide, qui se lirait comme une
panne.

**L'horloge se lit dans un instantané, non dans le socket de chrony.** La
proposition initiale — monter `/run/chrony/chronyd.sock` et parler le protocole
depuis Node — est **irréalisable** : ce socket est un socket *datagramme* unix,
et `node:dgram` n'ouvre que `udp4` et `udp6`. L'api lit donc un **fichier
d'instantané** (`CHRONY_ETAT_FICHIER`), et ignore qui l'écrit : un conteneur
d'appoint en `network_mode: host` sur l'instance d'évaluation, une tâche
planifiée de l'hôte ailleurs. Le découplage est le point : le produit n'a pas à
savoir comment l'exploitant atteint son démon de temps.

Un instantané absent ou périmé donne l'état **`indisponible`**, qui n'est pas
`non synchronisé` : le premier dit qu'on n'a pas su lire l'horloge, le second
qu'on l'a lue et qu'elle dérive. Seul le second lève le bandeau rouge de toute
la console ; `indisponible` s'affiche en orange sur l'écran d'état. Un bandeau
qui crierait à l'horodatage non fiable parce qu'un fichier manque userait
l'avertissement jusqu'à ce que plus personne ne le lise.

**Les sources de capture se dérivent de ce qui a été ingéré**, sans table
nouvelle : les valeurs distinctes de `Recording.source` et la date du dernier
dépôt de chacune. Le lot 08 remplacera cette dérivation par des sources
déclarées. C'est ce qui rend le critère de bout en bout du 05-4 jouable sans
préempter ce lot-là.

**Correction du relevé, après recette (05-1b).** Le quatrième champ de
`chronyc -c tracking` est une **date** de référence en secondes epoch, non un
âge en secondes ; le lire comme un âge donnait une dernière synchronisation en
1970 et un « aucune synchronisation depuis plus de vingt-quatre heures » sur une
horloge parfaitement à l'heure — bandeau rouge compris, sur toute la console.

Deux leçons y sont inscrites. D'abord, **ce que chrony affirme l'emporte sur ce
qu'on déduirait** : le quatorzième champ dit `Not synchronised` quand il l'est,
et cela vaut mieux qu'un stratum nul ou un identifiant de référence
particulier, qui ne sont que des indices. Ensuite, **une ligne trop courte n'est
pas un relevé** : elle est refusée entière plutôt que lue champ à champ, faute
de quoi des colonnes prises les unes pour les autres fabriqueraient un état.

Le défaut était de la famille exacte que le §9.36 prétend éviter : un
avertissement qui crie sans raison. Un bandeau faux use l'avertissement aussi
sûrement qu'un bandeau absent, et plus vite — parce qu'on apprend à le
regarder sans le lire. Le relevé réel de l'instance d'évaluation est désormais
une donnée de test, à la lettre.

**Réserve** — `Recording.source` est une énumération de trois valeurs
(`cucm-bib`, `siprec`, `simulator`) : elle nomme une *espèce* de source, pas un
instrument. Deux CUCM alimentant la même instance n'y font qu'une ligne, et
l'écran d'état ne saura pas dire lequel des deux s'est tu. C'est acceptable tant
qu'un client n'a qu'une chaîne de capture, et c'est précisément ce que le lot 08
corrigera. Par ailleurs, un réglage que l'environnement surcharge — le cas de
`TRUSTED_PROXIES` — crée une classe de champs modifiables sans effet : l'onglet
doit le dire à chaque fois, faute de quoi un administrateur croira avoir réglé
ce qu'il n'a pas réglé.

### 9.37 L'annuaire décide qui entre ; le produit garde une porte à lui (S6)

Deuxième sous-lot du lot 05. L'annuaire d'entreprise décide qui se connecte et
avec quel rôle, donc **qui peut entendre des conversations de clients**. C'est,
après la conservation, le réglage le plus lourd de la console.

**Rien n'est créé sans correspondance écrite.** Un compte naît d'une connexion
réussie et d'une règle qui vise l'un de ses groupes ; sans règle, la connexion
est refusée et le journal consigne **les groupes vus** — sans eux, « aucun
groupe mappé » n'aide pas l'administrateur à écrire la règle qui manque. Une
règle porte un groupe, un rôle et **un seul locataire** : un compte
n'appartient qu'à un locataire, et une liste dont seul le premier élément
compterait serait un piège. Plusieurs groupes donnent le rôle le plus élevé.

**Un compte local n'est jamais repris en silence.** Une adresse que possède
déjà un compte `local` refuse la connexion par annuaire, avec un événement
d'audit. Le rattachement est un acte d'administration explicite, parce qu'il
**retire son mot de passe** à son titulaire : la porte locale se referme, et
c'est irréversible sans une réinitialisation.

**Il reste toujours un administrateur local actif.** La règle du §9.26 est
étendue : ni la désactivation, ni la rétrogradation, ni le rattachement ne
peuvent retirer le dernier administrateur `source=local`. L'avant-dernier suit
le schéma en deux temps de la levée d'une conservation forcée (§9.29) — refus,
puis passage si l'appelant l'assume, et le fait est consigné.

**Un annuaire injoignable ne ferme pas la console.** C'est le corollaire de
l'invariant précédent, et l'implémentation l'a d'abord manqué : un refus
d'annuaire faisait échouer la connexion avant que la porte locale ait son mot à
dire, si bien qu'une panne de l'annuaire aurait verrouillé tout le monde — y
compris l'administrateur local que l'invariant préserve précisément pour ce
jour-là. Deux verdicts laissent donc la main au chemin local quand une porte
locale existe : **mot de passe refusé** — la même adresse peut exister des deux
côtés avec deux mots de passe différents, et un mode hybride n'a de sens que si
chacune des deux portes se prononce — et **annuaire injoignable**. Les deux
refus qui restent définitifs sont « aucun groupe mappé » et « adresse déjà
locale » : ils ne portent pas sur des identifiants mais sur une décision.

**Un compte d'annuaire n'a pas de mot de passe local**, et n'en obtient pas par
la bande : `User.passwordHash` devient nullable. Lui en donner un ouvrirait une
porte que l'annuaire ne saurait pas fermer en désactivant le compte. Il est
exclu de la politique de mot de passe et de l'écran de renouvellement, qui
n'auraient rien à changer.

**La synchronisation ne crée rien : elle retire.** Toutes les six heures par
défaut, elle désactive les comptes d'annuaire qui n'y sont plus ou qui sont
sortis des groupes mappés. C'est le seul mécanisme du produit qui ferme une
porte sans qu'un humain l'ait fait, et c'est pourquoi il ne fait que
désactiver, jamais supprimer. **Un annuaire injoignable ne désactive
personne** : on ne ferme pas des portes sur une panne de réseau.

**Le filtre est échappé (RFC 4515).** Un login contenant `*)(` réécrirait le
filtre et rendrait n'importe quel compte de l'annuaire. Le filtre doit par
ailleurs contenir `{login}` — sans lui, il rendrait toujours le même compte, et
n'importe qui entrerait sous l'identité de celui-là.

**`ldapts`, et une interface étroite.** Le produit ne demande à un annuaire que
trois choses : se lier, chercher un compte, vérifier des identifiants. L'étroitesse
borne ce que le produit sait faire et rend le chemin d'authentification
éprouvable sans serveur — ce qui compte pour un chemin qu'on ne veut pas
découvrir en production. Chaque opération ouvre et referme sa connexion : un
pool tiendrait des sockets vers le contrôleur de domaine d'une banque pendant
des heures, et une socket qu'on croit vivante coûte plus qu'une poignée de main.

**Réserve** — la synchronisation interroge l'annuaire compte par compte : c'est
sans conséquence sur les dizaines de comptes d'un service conformité, et à
revoir en une recherche unique si un client en ouvrait des centaines. Le login
est par ailleurs déduit de la partie locale de l'adresse, ce qui vaut tant que
les deux coïncident ; le jour où un annuaire les dissociera, il faudra retenir
le login à côté de l'adresse. Enfin, `externalId` est relevé mais ne sert pas
encore à retrouver un compte : un utilisateur renommé dans l'annuaire y
apparaîtra comme un compte nouveau, l'ancien étant désactivé à la
synchronisation suivante. C'est bruyant mais sûr — l'inverse, rattacher par
identifiant sans que personne ne l'ait décidé, contredirait la règle du
rattachement explicite.
