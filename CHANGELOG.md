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
- Fondement réglementaire reformulé : « exigences réglementaires bancaires »,
  la COBAC étant le premier cadre d'application et non le seul horizon. La cote
  de texte reste à établir et n'est citée nulle part dans le produit (§9.9).
- Habilitation d'écoute resserrée : entendre une conversation de client n'est
  pas un droit d'exploitation. Réécoute et export réservés à AUDITOR et ADMIN ;
  le SUPERVISOR garde la recherche, les métadonnées et l'empreinte. L'export
  suit l'écoute — une archive contient l'audio.
- `Recording.operationCategory` : ce qui se joue dans l'appel, non ce qu'il est
  (`confirmation_cheque`, `operation_change`, `autre`). Filtrable en recherche,
  porté par la fiche d'appel et les deux fiches d'export, prêt à recevoir des
  rétentions différenciées.
- Contrat §3 amendé sans changer la version de schéma : `category` y est
  facultatif, un producteur qui l'ignore reste conforme et son dépôt est rangé
  en `autre`. Une valeur inconnue part en quarantaine (§9.10).
- Journal d'audit du §6 : `GET /api/audit` paginé et filtrable (action,
  auteur, appel, plage de jours), écran dédié réservé à ADMIN et AUDITOR.
  **L'entrée « Journal d'audit » de la barre mène enfin quelque part** — le
  premier des deux fils du §9.5 est refermé.
- Les événements qu'aucun locataire ne réclame restent réservés à l'ADMIN de
  l'instance, et se distinguent à l'écran.
- Export CSV du journal filtré, taillé pour un tableur français (point-virgule,
  marque d'ordre d'octets, formules neutralisées). Lire le journal ne s'inscrit
  pas au journal ; l'extraire si — un extrait qui sort est une pièce (§9.11).
- `AUDIT_ACTIONS` partagé remis d'aplomb sur le schéma Prisma : `RETENTION_SET`
  y manquait depuis le lot 01.
- Tableau de bord du §6 : appels conservés, durée totale, stockage utilisé,
  appels sous conservation forcée et appels purgés, conservation en vigueur,
  volume quotidien sur trente jours et derniers dépôts écartés. **Le second
  fil du §9.5 est refermé.**
- Ouvert aux trois rôles, SUPERVISOR compris : il dit ce que pèse la
  conservation et si la chaîne tourne, jamais qui a écouté quoi (§9.12).
- Le graphe est mono-série et mono-teinte, sans légende, les jours creux
  dessinés à zéro — un graphe qui saute les journées vides dessine une
  activité continue là où le service a chômé. Les mêmes données sont données
  en chiffres juste en dessous.
- Chiffrement au repos (§8) : les pièces audio sont scellées en AES-256-GCM
  par **trames de 64 Kio**, chacune authentifiée avec l'en-tête et son propre
  rang. Un fichier scellé d'un bloc aurait interdit la lecture par plages du
  §6 ; en trames, le `Range` et le billet du §9.4 survivent sans changement.
- Une trame déplacée, transplantée depuis un autre fichier, ou un en-tête
  retouché sont refusés — un chiffrement qui n'empêche pas la permutation ne
  protège rien.
- Clé par fichier dérivée en HKDF de la clé maître, d'un sel et de
  l'identifiant de l'enregistrement ; `keyRef` retient la génération de clé.
  La base continue de porter l'empreinte et la taille du **clair**.
- Activation progressive : l'api lit les deux formats, et `storage:sceller`
  rattrape l'existant — en simulation par défaut, empreinte vérifiée avant
  toute réécriture. Décisions et réserves en §9.13.

- Sauvegarde et vérification de restauration : `sauvegarde:creer` prend le dump
  de la base (`pg_dump`, format custom), inventorie le stockage — une ligne par
  pièce, avec son empreinte et son état — et écrit le manifeste qui relie les
  deux. Les fichiers audio ne sont pas recopiés : leur copie relève de
  l'exploitant, l'inventaire est ce qui prouvera qu'elle est complète.
- **La clé maître n'entre jamais dans la sauvegarde**, seule son empreinte
  publique y figure — de quoi reconnaître la bonne clé à la restauration, rien
  de quoi ouvrir une pièce. Le fil laissé ouvert au §9.13 est refermé.
- `sauvegarde:verifier` confronte la prise à son manifeste, l'inventaire au
  disque et la clé détenue à celle qui a scellé les pièces : empreintes
  recalculées, déchiffrement compris. Elle constate une pièce absente, altérée,
  scellée sous une clé inconnue, un fichier qu'aucun enregistrement ne réclame,
  une déclaration d'origine disparue, et un fichier revenu à la place d'une
  pièce purgée. Sortie non nulle dès la première anomalie.
- La vérification dit jusqu'où elle est allée : sans clé, les sceaux ne sont pas
  ouverts et les pièces sont annoncées « présentes, intégrité non vérifiée »
  plutôt que comptées comme vérifiées.
- L'empreinte du manifeste s'affiche en fin de prise, à consigner hors de la
  sauvegarde : une sauvegarde qui s'auto-certifie ne certifie rien. Décisions et
  réserves en §9.14 de `CLAUDE.md` — dont l'absence de trace au journal, le
  manifeste en tenant lieu comme le `PurgeRun` au §9.7.
- Les commandes refusent une option inconnue : `--stockages` ne doit pas rendre
  « aucune anomalie » sans avoir regardé le stockage. Constaté à l'usage, où la
  valeur de `--empreinte` était prise pour un répertoire de sauvegarde.
- L'image docker de l'api embarque `postgresql-client` : la sauvegarde doit
  pouvoir tourner là où tourne l'api, sans dépendre d'un poste tiers.

- Constat d'après-restauration : `restauration:constater` confronte la base
  qu'on vient de remonter au manifeste et à l'inventaire d'une prise —
  migrations, locataires, et chaque enregistrement champ par champ. Il nomme ce
  qui diffère (« empreinte a… au lieu de 9f… »), il ne se contente pas de dire
  que quelque chose diffère.
- Une base plus avancée que la prise n'est pas une anomalie : restaurer puis
  appliquer les migrations parues depuis est une manœuvre saine. Une base en
  retard ou d'une autre lignée de migrations, si. Décisions en §9.15.
- Le constat se joue sur une **vraie** restauration en test : `pg_dump` puis
  `pg_restore` dans une base à part, constat fidèle, puis une ligne retirée de
  la base de secours que le constat signale.
- Correctif (§9.14 et §9.15) : les listes d'anomalies étaient plafonnées à vingt
  éléments et le rapport annonçait la longueur de la liste — cinq mille pièces
  disparues se lisaient « 20 pièce(s) absente(s) ». Un constat compte désormais
  tout, n'énumère que les premières, et dit combien il n'a pas énumérées.

- Scénario « contrôle COBAC » joué de bout en bout comme un test
  (`apps/api/test/controle-cobac.spec.ts`) : la téléphonie dépose, le portail
  range et scelle, puis un contrôleur interroge le périmètre de conservation,
  l'intégrité d'une pièce, qui a le droit de l'entendre, ce qui protège un
  appel sous enquête, comment on détruit, ce que le journal en dit, et ce qui
  se passerait si tout brûlait.
- Il se joue sur une instance **chiffrée au repos**, avec le vrai simulateur en
  ligne de commande et une graine fixée. Le seul artifice est le temps : deux
  appels sont vieillis en base, faute de pouvoir attendre deux ans qu'une
  conservation arrive à échéance.
- Ce que le contrôle établit, et qu'aucune déclaration ne remplace : le fichier
  rangé n'est pas un WAV lisible mais la réécoute rend l'empreinte de
  l'ingestion ; le superviseur cherche sans entendre ni emporter ; la fiche
  d'export recalcule l'empreinte au lieu de l'affirmer ; la conservation forcée
  épargne une pièce que la purge aurait détruite ; l'appel purgé garde sa fiche
  et rend 410 ; le journal ne se réécrit pas ; la sauvegarde se vérifie, et une
  clé qui n'est pas la bonne est reconnue comme telle.

**Sortie de jalon S4 atteinte** : rétention, conservation forcée, purge tracée,
export horodaté, journal d'audit, tableau de bord, chiffrement au repos,
sauvegarde et restauration — le tout joué en une fois, dans l'ordre d'un
contrôle.

### Durcissement (hors jalon)

- **L'adresse inscrite au journal d'audit était fausse dès qu'on livrait** :
  derrière le nginx du livrable, toutes les entrées portaient l'adresse du
  conteneur qui relaie. `TRUSTED_PROXIES` déclare nommément les relais dont on
  accepte le `X-Forwarded-For`, et reste vide par défaut — le croire sans
  réserve laisserait n'importe qui choisir l'adresse inscrite à son nom dans un
  journal qu'aucune route ne peut corriger.
- Limitation des tentatives de connexion par adresse, sur les seules routes
  d'authentification : une limitation générale casserait la réécoute, qui
  s'appuie sur des dizaines de requêtes `Range`. Seuls les échecs comptent —
  dans une banque, tout le personnel sort par une même adresse publique.
- Le blocage s'inscrit au journal une fois par épisode, sans locataire ni
  compte, plutôt qu'une entrée par tentative : un inconnu ne doit pas pouvoir
  gonfler un journal que rien ne peut purger. Aucune action nouvelle au §5.
- Politique de contenu du portail (`Content-Security-Policy` sans inline), et
  en-têtes de l'api resserrés : `default-src 'none'`, `frame-ancestors 'none'`,
  `Cross-Origin-Resource-Policy: same-origin`. HSTS n'est émis que derrière une
  terminaison TLS déclarée (`API_BEHIND_TLS`) : le promettre en clair serait une
  promesse qu'on ne tient pas.
- La CSP est protégée par un vrai build : le test construit le portail et
  vérifie qu'aucun `<script>` ni `<style>` en ligne n'est émis. Sans lui, le
  portail casserait en production seulement, là où aucun test ne regarde.
- Décisions et réserves en §9.16 — dont le compteur en mémoire, exact pour une
  instance par client (§9.1) et à revoir le jour où il y en aurait deux.

### S5 — Branchement réel (en cours)

- `tools/freeswitch/post-enregistrement.sh` : le script que FreeSWITCH appelle
  à la fin de chaque appel, qui dépose la paire wav+json du contrat §3. En bash
  et sans dépendance — on ne peut pas supposer Node installé sur une machine de
  capture. Il ne parle jamais à l'api : il écrit deux fichiers, et c'est tout ce
  que la frontière du §3 autorise.
- Il refuse au lieu de deviner : fréquence autre que 8 kHz, wav tronqué au
  regard de la durée annoncée, horodatage sans fuseau, sens ou catégorie hors
  contrat, locataire qui ne peut pas être un nom de répertoire, option inconnue.
  Le portail les mettrait en quarantaine ; mieux vaut échouer sur la machine de
  capture, pendant que l'appel est encore frais.
- La paire est préparée hors d'`INGEST_DIR` puis déplacée par un renommage
  atomique : un fichier de travail déposé sous surveillance partirait en
  quarantaine à chaque appel.
- **Le contrat tient : aucun changement n'a été nécessaire dans `apps/`.** Le
  dépôt est relu par les validateurs du contrat eux-mêmes, puis ingéré par le
  portail dans `apps/api/test/capture-freeswitch.spec.ts` — c'est là que se
  vérifie la promesse du §7, avant le jour du branchement plutôt que pendant.
- Dialplan d'intégration documenté (`tools/freeswitch/README.md`), avec le piège
  connu : `strftime(%z)` rend `+0100` là où le contrat attend `+01:00`.
- La CI passe les scripts shell à `shellcheck` : `set -e` rend certaines
  tournures piégeuses, `[ test ] && action` interrompant le script quand le test
  est faux — c'est-à-dire dans le cas normal. Décisions en §9.17.

### Démonstration record.voxecho.cm (hors jalon)

- Composition de production (`deploy/`) : Caddy termine le TLS en amont du
  livrable du §2, qui ne change pas — la chaîne devient Caddy → nginx → api, et
  `TRUSTED_PROXIES` couvre le réseau des conteneurs pour que le journal d'audit
  continue d'inscrire l'adresse du demandeur et non celle d'un relais.
- Les images sont publiées sur GHCR par la CI à chaque `main`, taguées par SHA :
  une t3.small a deux gigaoctets, la construction y échouerait. Revenir en
  arrière est un changement de variable, pas une reconstruction.
- `GET /api/instance` et mention « instance de démonstration » sur l'écran de
  connexion : un visiteur ne doit pas pouvoir croire qu'il regarde les
  conversations de vrais clients. C'est l'instance qui la commande, jamais le
  portail seul — sinon elle apparaîtrait chez un client.
- Jeu de démonstration déposé dans `INGEST_DIR`, jamais inséré en base : c'est
  l'ingestion du produit qui range, empreint et scelle. Un dépôt volontairement
  malformé garnit les quarantaines du tableau de bord.
- Les mots de passe de démonstration viennent de l'environnement ; le seed
  refuse un mot de passe court ou laissé à une valeur d'exemple. L'instance est
  publique.
- `robots.txt` en complément du `X-Robots-Tag` déjà servi, et marque de
  l'éditeur sur l'écran de connexion.
- Procédure d'installation pas-à-pas (`deploy/INSTALLATION.md`), exercice de
  restauration compris — celui que la réserve du §9.15 promettait de jouer avant
  toute mise en service. Décisions en §9.18.
- `deploy/RUNBOOK.md` : les trente étapes de mise en service, numérotées, avec
  pour chacune ce qu'elle exige (le jeton GitHub) et ce qu'elle produit — une
  sortie à conserver, ou un secret à ne montrer à personne. `INSTALLATION.md` y
  renvoie plutôt que de répéter les commandes : deux documents qui décrivent le
  même geste finissent par diverger, et c'est celui qu'on ne lit pas qui reste
  faux.
- Correctif : `deploy/.env.prod.example` n'était pas versionné — `.gitignore`
  excluait `.env.*` et `git add -A` l'ignorait sans un mot. Le manque ne s'est vu
  qu'en lisant le runbook sur l'instance, à l'étape qui en a besoin. Le modèle
  est désormais suivi, et quatre vérifications le protègent : fichiers de
  déploiement versionnés, toutes les variables de la composition déclarées dans
  le modèle, aucun secret dans le modèle, et aucun port publié hors 80 et 443.
- Correctif de mise en service : l'api redémarrait en boucle sur
  « invalid port number in database URL ». Le compose assemblait l'URL de
  connexion par concaténation et le mot de passe, tiré en base64, contenait un
  `/` — qui referme la partie autorité d'une URL. Le message désignait le port,
  le coupable était le mot de passe.
- La composition passe désormais les composants ; le produit construit l'URL en
  encodant identifiant et mot de passe, une seule fois, au même endroit. Le
  point d'entrée de l'image l'obtient du même module avant de migrer, et les
  commandes d'exploitation, qui le court-circuitent, l'appellent aussi.
- Éprouvé sur une vraie connexion : un rôle PostgreSQL dont le mot de passe
  contient `/`, `+` et `=`, une connexion qui aboutit, et la même assemblée à
  l'ancienne qui échoue. Un garde-fou refuse toute concaténation d'URL
  réintroduite dans un compose. Décisions en §9.19.
- Écran de connexion : le nom de l'éditeur et sa ville sont retirés. Le produit
  se présente par ce qu'il fait — « VoxEcho Record, enregistrement d'appels de
  conformité » — sans ancrage géographique. L'information de verrouillage après
  plusieurs échecs reste : elle explique un refus qu'un auditeur rencontrerait
  sinon sans comprendre. Le fuseau d'affichage, lui, ne bouge pas : une heure
  d'appel est une donnée probante, pas un élément de présentation (§9.20).
