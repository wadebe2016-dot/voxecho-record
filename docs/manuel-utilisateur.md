# VoxEcho Record — manuel d'utilisation

Ce manuel porte les explications que les écrans ne donnent plus. Le portail
affiche des libellés courts et une icône d'aide (ⓘ) au survol ; ce qui demande
un paragraphe est ici.

Chaque section renvoie à la décision qui la fonde dans `CLAUDE.md`, pour qui
veut savoir _pourquoi_ le produit se comporte ainsi.

---

## Connexion

L'accès est réservé aux personnes habilitées et **chaque consultation est
tracée** : recherche, écoute, export et extraction du journal laissent une
entrée nominative au journal d'audit.

Après cinq échecs de connexion, le compte est verrouillé un quart d'heure. Une
limitation par adresse s'y ajoute : au-delà de dix échecs en une minute depuis
la même adresse, les tentatives sont refusées, et le blocage est inscrit au
journal (§9.16).

Sur une instance d'évaluation, un bandeau l'annonce : les appels présentés sont
fabriqués, aucune conversation réelle de client n'y figure (§9.21).

## Enregistrements

La liste des appels conservés. La recherche cumule ses critères — numéro (poste
ou correspondant, correspondance partielle), plage de dates, sens, durée,
catégorie d'opération — et aucun ne peut élargir le périmètre au-delà du
locataire.

Les bornes de dates s'entendent en journées d'Africa/Douala : un appel du 1er à
23 h 30 sort dans une recherche sur le 1er, celui du 2 à 00 h 30 non.

**Consulter une fiche n'écoute rien.** L'empreinte SHA-256 s'y lit en entier
sans qu'aucune écoute soit inscrite au nom de qui vient seulement la relever.
L'écoute commence au bouton, et elle est tracée (§9.4).

Un appel **purgé** garde sa fiche : empreinte, taille, durée et chemin
subsistent, et la recherche continue de le montrer. Son audio a été détruit —
l'écoute répond alors « plus d'audio », jamais « introuvable » (§9.7).

### Écoute et export

Entendre une conversation de client n'est pas un droit d'exploitation :
réécoute et export sont réservés aux rôles **auditeur** et **administrateur**.
Le superviseur cherche, consulte les métadonnées, relève l'empreinte et constate
l'intégrité — il n'écoute pas (§9.9).

L'export produit une archive ZIP contenant le fichier audio, une `fiche.pdf`
d'une page et une `fiche.json` de même contenu : métadonnées, empreinte en
entier, demandeur, horodatage.

**L'empreinte est recalculée sur le fichier au moment de l'export**, puis
confrontée à celle relevée à l'ingestion. La fiche ne se contente pas
d'affirmer que la pièce est intacte : elle le vérifie et le date. En cas de
divergence, l'export n'est pas refusé — il faut bien pouvoir sortir la pièce
pour enquêter — mais la fiche s'ouvre sur un avertissement, le JSON porte
`integrite: "divergente"`, et l'écart est consigné (§9.8).

## Politiques d'enregistrement

Ce que la capture doit enregistrer, et ce qu'elle doit laisser passer.

> **À ce jour, une politique publiée n'est pas encore appliquée par la
> capture.** Le référentiel, les écrans et le simulateur fonctionnent ; la
> publication aux connecteurs et la décision à la source viennent aux lots
> suivants (§9.23).

### Ordre d'évaluation

1. **Jamais enregistrés** — les exclusions priment sur toutes les règles, quel
   que soit leur ordre. C'est là que se déclarent les lignes qu'on ne capte
   jamais : ressources humaines, médecine du travail, représentation du
   personnel. Elles sont séparées des règles pour qu'un réordonnancement ne
   puisse pas les contourner.
2. **Règles** — évaluées de haut en bas, **la première qui correspond décide**.
3. **Par défaut** — ce qui s'applique quand aucune règle ne correspond.

Le défaut du produit enregistre tout, et sans politique publiée tout est
enregistré : ne pas enregistrer doit résulter d'une décision écrite, jamais d'un
oubli de règle ou d'un référentiel vide.

### Écrire une règle

| Critère               | Ce qu'il compare                                        |
| --------------------- | ------------------------------------------------------- |
| Poste enregistré      | le poste interne (`1001`, ou `10*` en préfixe)          |
| Correspondant         | le numéro externe (`699112233`, ou `699*`)              |
| Liste nommée          | l'appartenance à une liste — poste **ou** correspondant |
| Sens de l'appel       | `inbound`, `outbound`, `internal`                       |
| Catégorie d'opération | `confirmation_cheque`, `operation_change`, `autre`      |

Une règle sur la catégorie `autre` n'attrape pas un appel dont le producteur n'a
déclaré aucune catégorie : c'est l'ingestion qui range en « autre » ce qui n'est
pas classé, et au moment de décider, l'absence n'est pas un choix.

Les **listes nommées** tiennent lieu de service ou de département tant qu'aucun
annuaire n'est branché.

### Décisions

- **Toujours enregistrer** / **Ne jamais enregistrer**.
- **Échantillonner** — un taux de 1 à 99 %. Le tirage est **déterministe** : la
  même référence d'appel donne toujours le même résultat, qu'un contrôleur peut
  recalculer des mois plus tard. C'est ce qui permet de répondre à « pourquoi
  cet appel-là n'a-t-il pas été enregistré ? » autrement que par « le hasard ».
- **À la demande de l'agent** — l'appel n'est pas capté d'office ; l'agent le
  déclenche pendant la conversation. Non déclenché, il reste un appel non
  enregistré, motivé comme tel.

Deux options s'ajoutent à une règle : **annonce** à l'appelant, et **pause
autorisée** pour une saisie sensible (numéro de carte). Elles sont déclarées
ici et exécutées par le connecteur.

### Brouillon, publication, historique

Un seul brouillon à la fois. Il se modifie et s'abandonne librement : **il n'a
aucun effet sur la capture tant qu'il n'est pas publié**, et il ne laisse
aucune trace au journal.

La publication exige une note d'au moins dix caractères — un contrôleur la
lira — et inscrit un événement `POLICY_SET`. Republier un brouillon identique à
la version en vigueur est refusé : empiler des versions identiques brouillerait
un historique dont toute la valeur est de dater les changements.

**Une version publiée ne se modifie plus ; on en publie une nouvelle.** C'est ce
qui permet de dire, plus tard, quelle politique s'appliquait à une date donnée —
et un déclencheur en base l'impose, au-delà de l'absence de bouton.

### Simuler avant de publier

Le simulateur rejoue le **moteur qu'exécutera la capture** : ce n'est pas une
approximation d'aide à la saisie, c'est la décision réelle. Il porte sur le
brouillon quand il y en a un, pour qu'on voie ce qu'une politique changera avant
de la rendre opposable.

## Journal d'audit

Consultable par les rôles auditeur et administrateur, filtrable par action,
auteur, appel et plage de jours. Le superviseur n'y a pas accès : le journal dit
qui a entendu quoi, et le donner à lire à qui n'a pas l'habilitation d'écoute
reviendrait à lui livrer indirectement l'activité des auditeurs (§9.11).

**Lire le journal ne s'inscrit pas au journal ; l'extraire si.** Un export CSV
sort du produit et devient une pièce autonome : il est tracé, avec ses critères
et son nombre de lignes. Au-delà de 50 000 lignes, l'extrait est tronqué et
l'annonce.

Le CSV est fait pour un tableur français : séparateur point-virgule, marque
d'ordre d'octets, et les valeurs commençant par `=`, `+`, `-` ou `@` sont
préfixées d'une apostrophe — un motif saisi par un humain ne doit pas s'exécuter
dans un tableur.

## Tableau de bord

Volume par jour sur trente jours, durée totale, stockage utilisé, appels sous
conservation forcée, appels purgés, conservation en vigueur et derniers dépôts
écartés.

Ouvert aux trois rôles, superviseur compris : il dit ce que pèse la conservation
et si la chaîne tourne, **jamais qui a écouté quoi** (§9.12).

Le stockage utilisé ne compte que ce qui est réellement sur le disque : un appel
purgé garde sa fiche et ne pèse plus rien, il est compté à part.

Les jours sans appel sont dessinés à zéro plutôt qu'omis — un graphe qui saute
les journées vides dessine une activité continue là où le service a chômé.

## Conservation

*Administration › Conformité › Conservation.* Lisible par les trois rôles, seul
l'administrateur du locataire la modifie.

Deux niveaux : une **durée générale**, et une durée par **catégorie
d'opération**. La plus précise l'emporte — conserver dix ans les ordres de
change et deux ans le reste suppose de pouvoir faire les deux (§9.28).

Chaque ligne dit d'où vient la durée qui s'applique :

- **décidée** — une politique a été enregistrée pour ce périmètre, avec sa date ;
- **héritée** — aucune politique propre : la catégorie suit la durée générale,
  et la générale suit le défaut du produit (730 jours).

Sans cette distinction, on ne saurait pas si 730 jours résultent d'un choix ou
d'un défaut.

### Les deux minimums

Ils ne disent pas la même chose, et ne se franchissent pas de la même façon.
Tous deux sont **fixés par Atlastech au déploiement** et s'affichent en lecture
seule : ce sont des garanties posées à l'installation, pas des réglages client.

- **Plancher de l'instance** (`RETENTION_MIN_DAYS`) — descendre en dessous reste
  possible, mais exige un **motif écrit** d'au moins dix caractères. Le motif
  est conservé sur la politique, affiché à côté d'elle, et inscrit au journal :
  un contrôleur voit du premier coup d'œil qu'il lit une politique dérogatoire,
  et le journal lui dit qui a dérogé (§9.6).
- **Minimum réglementaire** (`RETENTION_REGULATORY_FLOORS`, par catégorie) — il
  **ne se déroge pas**. Une durée inférieure est refusée, motif ou non. Il vaut
  zéro tant qu'aucun texte n'est déclaré : le produit ne fait pas semblant de
  connaître une durée légale (§9.30).

Le motif de dérogation n'est demandé que sous le plancher de l'instance, et
refusé au-dessus : un motif accroché à une politique qui ne déroge à rien ferait
croire à une dérogation qu'il n'y a pas.

## Conservation forcée

*Depuis la fiche d'un appel.* Une conservation forcée soustrait l'appel à la
purge, quelle que soit son ancienneté, jusqu'à sa levée. Elle est ouverte à
l'administrateur et au superviseur ; l'auditeur consulte l'historique sans y
toucher — il constate, il n'ordonne pas.

**La pose** demande un motif et une **référence de dossier**. « Réquisition
judiciaire » dit ce qu'on fait ; « n° 2026-118 du parquet de Douala » dit de quoi
on parle, et c'est cette seconde information qu'un contrôleur demandera. La
forme est libre — chaque banque numérote ses dossiers à sa façon (§9.29).

**La levée demande un second administrateur.** Celui qui a posé ne peut pas
lever : défaire seul ce qu'on a seul décidé rendrait la conservation aussi
solide que la volonté d'une personne. Un administrateur désactivé ne compte pas
comme second.

L'exception est assumée, en deux temps. Une instance qui n'a qu'un
administrateur actif ne peut pas se retrouver dans l'impossibilité de lever une
conservation devenue sans objet : la levée est d'abord **refusée**, avec un
message qui explique la situation, puis l'écran propose de l'assumer
explicitement. Le journal porte alors « levée sans contre-validation », et la
mention reste sur la ligne.

La fiche affiche la mesure en cours avec son motif, son dossier, son auteur et
sa date. Les conservations levées restent consultables sous la mesure en cours.

## Rapports de purge

*Administration › Conformité › Purge.* Lisibles par les trois rôles — c'est la
pièce qu'un auditeur vient vérifier.

**Aucune purge ne se déclenche seule** (§9.7). Le produit énumère, un
responsable conformité valide, un administrateur exécute. La contrepartie est
assumée : sans intervention humaine, rien n'est jamais purgé et le stockage
croît. On préfère un disque plein à une preuve détruite par inadvertance.

1. **Établir un rapport** (administrateur ou superviseur) fige la politique en
   vigueur, l'échéance qui en découle, la liste des appels échus, ce qu'ils
   pèsent, et ceux qu'une conservation forcée épargne — avec le motif du hold,
   pour que le rapport se lise sans autre source.
2. **Lire le rapport.** Les durées figées s'affichent toutes, périmètre par
   périmètre : un rapport où les ordres de change relèvent de dix ans et le
   reste de deux se lirait autrement comme un rapport à deux ans. Chaque ligne
   porte la durée qui l'a jugée.
3. **Exécuter** (administrateur seulement), avec un motif d'au moins dix
   caractères. Le rapport est **rejoué** tel qu'il a été écrit — jamais
   recalculé à la date du jour. Si la réalité ne lui correspond plus (une
   conservation posée depuis, un appel qui a franchi l'échéance, une durée
   modifiée), l'exécution est refusée et il faut établir un nouveau rapport.

Un appel purgé garde sa fiche, son empreinte, sa taille et sa durée : il
continue de sortir dans les recherches, et l'écoute rend un refus explicite
plutôt qu'un « introuvable ».

### Certificat de destruction

Un rapport **exécuté** ouvre un certificat, en PDF et en CSV. C'est la pièce que
la banque range dans son dossier de conformité : ce qui a été détruit, quand, au
nom de quelle durée, et sur l'ordre de qui (§9.31).

Le PDF se range et se présente ; le CSV se recoupe avec un inventaire. Les deux
portent la **même empreinte**, car elle est calculée sur le contenu et non sur
le fichier — et elle est figée à l'instant de la destruction, non au premier
téléchargement. Chaque téléchargement s'inscrit au journal comme un export.

Un rapport encore simulé n'ouvre aucun certificat : en délivrer un pour une
destruction qui n'a pas eu lieu serait un faux.

## Comptes

Réservés à l'administrateur du locataire. Un compte **ne se supprime pas, il se
désactive** : le journal d'audit référence son auteur, et l'effacer effacerait
le lien vers ce qu'il a écouté.

À la création, le produit engendre un **mot de passe provisoire** affiché une
seule fois — il n'est stocké nulle part en clair, et l'écran de création est le
seul endroit où il paraîtra. Son titulaire doit le remplacer à la première
connexion : tant qu'il ne l'a pas fait, aucun autre écran ne lui est accessible,
et l'api refuse tout le reste.

Le mot de passe provisoire s'écrit en quatre groupes de quatre caractères, sans
`O` ni `0`, sans `I` ni `1` : il se dicte au téléphone.

**Réinitialiser** un compte engendre un nouveau provisoire, révoque les sessions
ouvertes et lève un éventuel verrouillage.

Un administrateur **ne modifie pas son propre compte** : se rétrograder ou se
désactiver soi-même reviendrait à se fermer la porte de l'intérieur. Un autre
administrateur le fait.

Le **dernier administrateur de l'instance** ne peut être ni rétrogradé, ni
désactivé, ni révoqué : sans lui, la console d'administration se fermerait à
tout le monde.

### Politique de mot de passe

Longueur minimale de douze caractères par défaut, réglable à l'installation.
Sont refusés les suites courantes, les mots de passe contenant l'adresse de leur
titulaire, et ceux formés de trop peu de caractères distincts.

**Il n'y a pas d'expiration périodique**, et c'est délibéré : imposer un
changement tous les trimestres produit des variantes numérotées et des
pense-bêtes. La protection tient au verrouillage après cinq échecs, à la
limitation par adresse, et au renouvellement imposé des mots de passe
provisoires (§9.26).

## Administration de l'instance

Réservée aux administrateurs de **l'instance**, distincts des administrateurs
d'un locataire : régler la conservation de sa banque et régler l'instance qui
héberge toutes les banques ne sont pas la même responsabilité (§9.22).

Ce privilège ne se donne pas depuis le portail. Il s'accorde par une commande
d'exploitation, donc par un accès au serveur :

```bash
node apps/api/dist/administration/admin-instance.js --promouvoir admin@exemple.cm
node apps/api/dist/administration/admin-instance.js --lister
```

Un privilège qui se donnerait depuis l'écran qu'il déverrouille ne protégerait
de rien.

### Onglet Réseau

*Administration › Instance › Réglages › Réseau.* Réservé à l'administrateur de
l'instance.

**Fuseau horaire.** Le fuseau dans lequel le portail présente toutes ses dates.
Il ne touche pas à la base, qui écrit toujours en UTC et dont l'api vérifie le
réglage au démarrage : changer le fuseau change l'affichage, jamais ce qui est
écrit.

**État de l'horloge**, en lecture seule, rafraîchi toutes les minutes : source,
décalage, stratum, dernière synchronisation. Quatre états :

| État | Ce qu'il dit |
| --- | --- |
| Synchronisée | décalage sous 500 ms |
| Dérive | décalage au-delà de 500 ms |
| Non synchronisée | décalage au-delà de 5 s, aucune source, ou aucune synchronisation depuis 24 h |
| État indisponible | le relevé manque ou date de plus de cinq minutes |

Tant que l'horloge est **non synchronisée**, un bandeau rouge s'affiche en tête
de toute la console, pour les trois rôles : un auditeur qui relève une empreinte
doit savoir que l'heure inscrite à côté n'est peut-être pas défendable.

« État indisponible » ne lève pas ce bandeau. Ce n'est pas la même chose : l'un
dit qu'on a lu l'horloge et qu'elle ne suit plus, l'autre qu'on n'a pas su la
lire. Un bandeau qui crierait pour le second userait l'avertissement.

**Comment le relevé est produit.** L'api ne peut pas interroger `chronyd`
elle-même — son socket de commande est un socket datagramme unix, que Node
n'ouvre pas. Le compose de production lance un conteneur `horloge` qui partage
le réseau de l'hôte, exécute `chronyc -c tracking` toutes les trente secondes et
dépose la sortie dans un volume que l'api lit (`CHRONY_ETAT_FICHIER`). Ce
conteneur ne règle rien : c'est un relevé, pas un agent. Sur une installation
qui ne peut pas l'employer, n'importe quelle tâche planifiée écrivant le même
fichier fait l'affaire — le produit ignore qui l'écrit.

**Serveurs de temps et résolution de noms** ne s'affichent que sur un boîtier
installé (`VOXECHO_DEPLOY_MODE=onprem`). En nuage, une ligne dit qui rend le
service à la place du produit. Sur un boîtier, la valeur saisie est **conservée
et affichée, jamais appliquée** : l'écriture de la configuration de l'hôte
viendra avec l'agent `voxecho-hostd`. Le bouton « Tester » vérifie ce qu'on peut
vérifier — que les noms se résolvent — et s'inscrit au journal, en échec comme
en succès.

**Relais de confiance.** Les adresses dont l'en-tête `X-Forwarded-For` est cru,
donc ce qui décide de l'adresse inscrite au journal d'audit (§9.16). La
**variable d'environnement l'emporte** sur la valeur saisie : un administrateur
ne doit pas pouvoir fausser depuis l'interface l'adresse inscrite à son nom dans
un journal que rien ne peut corriger. L'onglet dit laquelle des deux s'applique.

### Réglages en lecture seule

Certains réglages s'affichent sans pouvoir être modifiés depuis la console :

- **`TRUSTED_PROXIES`** — les relais dont l'en-tête `X-Forwarded-For` est cru,
  donc ce qui décide de l'adresse inscrite au journal d'audit. Modifiable depuis
  la console, un compte compromis déclarerait confiance à tout le monde et se
  rendrait invisible du journal (§9.16).
- **`RETENTION_MIN_DAYS`** — le plancher de conservation de l'instance. Un
  plancher qu'on abaisse d'un clic ne protège plus rien : il se règle à
  l'installation (§9.6).

La clé maître de chiffrement n'est jamais affichée : seule son **empreinte
publique** l'est, celle qui permet de reconnaître la bonne clé le jour d'une
restauration sans jamais la révéler (§9.14).
