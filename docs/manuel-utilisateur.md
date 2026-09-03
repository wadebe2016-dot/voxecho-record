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
