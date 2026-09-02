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
  avec le simulateur.
- `tools/simulator` : appels plausibles sans téléphonie — numéros camerounais,
  heures ouvrées, durées de 15 s à 10 min penchant vers les appels courts,
  audio en deux tonalités alternées. Modes `--one`, `--batch <n>`,
  `--continuous <n>/min` et `--corrupt` (json malformé et wav tronqué en
  alternance) ; `--seed` rejoue un lot à l'identique, `--tenant` vise un ou
  plusieurs locataires, `--spread-days` étale le lot sur plusieurs jours.
- Le simulateur est vérifié avec les validateurs du contrat eux-mêmes : ce
  qu'il dépose est relu par `parseIngestMetadata`, `parseRadical` et
  `readWavHeader`, ceux-là mêmes qu'appelle l'ingestion — 232 tests.

Sortie de jalon S2 atteinte : `--batch 50` donne 50 enregistrements en base,
50 empreintes distinctes, répertoire d'ingestion vidé. Un lot `--corrupt` de
6 appels finit intégralement en quarantaine, tracé ; le même lot redéposé
avec la même graine est reconnu comme identique et retiré sans doublon.

### S3 — Portail

- Recherche du §6 : par numéro (poste **ou** correspondant, correspondance
  partielle), plage de dates, sens et durée min/max. Les critères se cumulent
  et aucun ne peut élargir le périmètre au-delà du locataire du jeton.
- Les bornes de dates sont saisies en date locale et interprétées sur la
  journée d'Africa/Douala : un appel du 1er à 23 h 30 sort bien dans une
  recherche sur le 1er, celui du 2 à 00 h 30 non — malgré leur date UTC
  identique.
- Chaque recherche est tracée avec ses critères (`AuditEvent SEARCH`), et le
  portail ne cherche qu'à la validation du formulaire : chercher à la frappe
  noierait le journal sous des recherches que personne n'a demandées.
- Correctif CI : `pnpm/action-setup@v4` refusait que la version de pnpm soit
  déclarée à la fois par le workflow et par `packageManager`.
- Correctif CI : chaque worker Jest travaille désormais dans son propre schéma
  PostgreSQL (`test_1`…`test_N`). Sur un schéma partagé, le vidage des tables
  entre deux cas détruisait les données d'un autre worker — invisible sur une
  machine à deux cœurs, systématique sur un runner qui en a quatre.
- `packages/shared` est émis en double, CommonJS pour l'api et les outils Node,
  ESM pour le portail. Le portail n'en importait jusqu'ici que des types,
  effacés à la compilation ; la première valeur importée (`INGEST_DIRECTIONS`)
  a cassé la construction, Rollup ne sachant pas suivre un export nommé à
  travers une chaîne de `export *` en CommonJS.
- CLAUDE.md §9.3 : le stockage range par `tenantId` quand l'ingestion lit le
  `slug`. Le chemin d'une preuve ne doit dépendre d'aucune donnée renommable —
  une fusion ou un changement de raison sociale ne doit jamais obliger à
  déplacer des fichiers déjà conservés.
- Réécoute du §6 côté api : `GET /api/recordings/:id/audio` sert le WAV en
  flux, `Range` compris (`206`, `Content-Range`, `416` avec la taille réelle),
  sans jamais mettre une pièce probante en cache.
- `POST /api/recordings/:id/listen` ouvre l'écoute et inscrit au journal
  l'événement `LISTEN` — une entrée par écoute, pas par requête `Range`.
  Décision et réserve en §9.4 de `CLAUDE.md`.
- Fichier disparu du stockage : `404` et incident journalisé bruyamment ;
  enregistrement purgé : `410`. Aucun des deux ne se confond avec une requête
  malformée.
- Portail : fiche d'appel et lecteur. Consulter une fiche n'écoute rien —
  l'empreinte SHA-256 s'y lit en entier, sans qu'aucune écoute ne soit
  inscrite au nom de qui vient seulement la relever. L'écoute commence au
  bouton « Écouter cet appel », et le portail annonce à l'auditeur qu'elle
  est tracée.
- Démo bout-en-bout jouée comme un test : le vrai simulateur dépose un lot à
  graine fixée, l'ingestion le range, un auditeur cherche, écoute, et le
  journal rend compte. Elle se rejoue à chaque CI plutôt que de dépendre de
  quelqu'un qui se souvient des commandes.
- CLAUDE.md §9.5 : l'écran du journal d'audit et le tableau de bord du §6 sont
  arrimés à la fin du S4. L'entrée « Journal d'audit » de la barre de navigation
  ne mène encore nulle part — le manque est assumé et daté plutôt que masqué.
- Correctif (revue S3) : une borne de date bien formée mais inexistante au
  calendrier est refusée. « 2026-09-32 » finissait en erreur serveur, et
  « 2026-02-30 » — plus grave — était reporté au 1er mars sans un mot : la
  recherche portait sur une journée que personne n'avait demandée pendant que
  le journal d'audit consignait le critère tel qu'il avait été saisi.
- Correctif (revue S3) : les répertoires de données sont ancrés à la racine du
  dépôt et non au répertoire courant. `pnpm dev` lance l'api depuis `apps/api`,
  où `./data/storage` désignait `apps/api/data/storage` : toute réécoute
  rendait 404 sur des preuves pourtant bien rangées, et l'ingestion surveillait
  un répertoire vide qu'elle venait de créer. Invisible en livraison, où les
  chemins sont absolus.

Sortie de jalon S3 atteinte : recherche, réécoute streamée et écoutes tracées,
démontrées bout en bout sur des données simulées.

### S4 — Conformité

- Rétention par locataire : défaut 730 jours (deux ans), réglable, avec un
  plancher d'instance (`RETENTION_MIN_DAYS`). Descendre en dessous exige un
  motif écrit, conservé sur la politique en vigueur et inscrit au journal —
  un contrôleur voit qu'il lit une dérogation, et par qui elle a été décidée.
- Nouvelle action au journal, `RETENTION_SET` : l'acte le plus lourd du
  produit — programmer la destruction de preuves à terme — ne laissait jusque
  là aucune trace. Écart au §5 assumé en §9.6 de `CLAUDE.md`.
- Conservation forcée : pose et levée motivées, tracées (`HOLD_SET`,
  `HOLD_RELEASE`), historique consultable. Un hold actif est une ligne non
  levée de `LegalHold` — source unique, `RecordingStatus.hold` reste
  inutilisé pour que rien ne puisse diverger au moment de la purge.
- Le portail marque les appels sous conservation forcée dans la liste et sur
  la fiche, à côté du statut du fichier et jamais à sa place. Poser ou lever
  une mesure reste une opération d'api à ce stade.
- Purge : aucune destruction automatique. Le produit énumère, un responsable
  conformité valide, un ADMIN exécute. Un balayage qui détruirait de lui-même
  des pièces probantes ferait de la conservation une affaire de `cron`.
- Le rapport de purge est l'autorisation, pas un affichage : politique et
  échéance figées, liste des appels échus avec leur poids, et ceux qu'une
  conservation forcée épargne — motif du hold compris. Il se relit, se
  filtre et s'annule.
- L'exécution rejoue le rapport plutôt que de le recalculer, et le refuse si
  l'ensemble énuméré a changé depuis : hold posé entre-temps, appel
  nouvellement échu, conservation modifiée. Ce qui a été autorisé est
  exactement ce qui est détruit.
- Un appel purgé perd son fichier, garde sa ligne : empreinte, taille, chemin
  et durée subsistent, la recherche continue de le montrer et l'écoute rend
  `410`. Un `PURGE` par enregistrement détruit, portant le motif, le rapport
  et le SHA-256 de ce qui vient de disparaître. Décisions en §9.7.
- Export horodaté : archive ZIP contenant l'audio, une `fiche.pdf` d'une page
  et une `fiche.json` de même contenu — métadonnées, empreinte en entier,
  demandeur, horodatage. `EXPORT` tracé, bouton sur la fiche d'appel.
- L'empreinte est **recalculée sur le fichier au moment de l'export** et
  confrontée à celle de l'ingestion : la fiche vérifie l'intégrité au lieu de
  l'affirmer d'après la base. Les deux empreintes et le verdict vont au
  journal.
- Une divergence n'empêche pas l'export, elle l'annote : avertissement en tête
  du PDF, `integrite: "divergente"` dans le JSON, alerte au portail, écart
  consigné. Le produit ne refuse pas de livrer, il refuse de mentir (§9.8).
