# Installation de `record.voxecho.cm`

Instance de évaluation, Ubuntu 24.04 sur t3.small, IP `15.188.164.226`,
`record.voxecho.cm` en DNS only (nuage gris) chez Cloudflare — le flux ne
transite par aucun intermédiaire qui le déchiffrerait au passage, ce qui est la
moindre des choses pour un enregistreur de conformité.

Les images sont **construites par la CI** et publiées sur GHCR : une t3.small a
2 Go de mémoire, où la construction échouerait. L'instance ne fait que tirer.

Connexion : EC2 Instance Connect, utilisateur `ubuntu`.

## La procédure

Elle est dans **[RUNBOOK.md](RUNBOOK.md)** : trente étapes numérotées, de la
préparation de la machine à l'exercice de restauration, avec pour chacune ce
qu'elle exige (le jeton GitHub) et ce qu'elle produit (une sortie à conserver,
ou un secret à ne montrer à personne).

Les commandes ne sont pas répétées ici : deux documents qui décrivent le même
geste finissent toujours par diverger, et c'est celui qu'on ne lit pas qui reste
faux.

## Mettre à jour

```bash
cd /opt/voxecho && git pull
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env pull
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d
```

Pour revenir en arrière, figer `VOXECHO_TAG` sur un SHA dans `deploy/.env` et
relancer : les images sont taguées par commit.
