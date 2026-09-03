# Installation de `record.voxecho.cm`

Instance de démonstration, Ubuntu 24.04 sur t3.small, IP `15.188.164.226`,
`record.voxecho.cm` en DNS only (nuage gris) chez Cloudflare — le flux ne
transite par aucun intermédiaire qui le déchiffrerait au passage, ce qui est la
moindre des choses pour un enregistreur de conformité.

Les images sont **construites par la CI** et publiées sur GHCR : une t3.small a
2 Go de mémoire, où la construction échouerait. L'instance ne fait que tirer.

Connexion : EC2 Instance Connect, utilisateur `ubuntu`.

## 1. Préparer la machine

```bash
# Un peu d'échange : 2 Go de RAM, quatre conteneurs, et un pic à la migration.
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

sudo apt-get update && sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" |
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker ubuntu
# Refermer la session Instance Connect et se reconnecter pour que le groupe prenne.
```

## 2. Récupérer le dépôt et se connecter au registre

Le dépôt et les images sont privés : il faut un jeton GitHub (_fine-grained_,
lecture du dépôt et `read:packages`). Il ne sert qu'ici.

```bash
sudo mkdir -p /opt/voxecho && sudo chown ubuntu:ubuntu /opt/voxecho
cd /opt/voxecho
read -rsp 'Jeton GitHub : ' GH_TOKEN && echo
git clone https://wadebe2016-dot:${GH_TOKEN}@github.com/wadebe2016-dot/voxecho-record.git .
echo "$GH_TOKEN" | docker login ghcr.io -u wadebe2016-dot --password-stdin
unset GH_TOKEN
```

## 3. Générer les secrets

Aucun de ces secrets ne revient dans le dépôt. La clé maître commande la
lisibilité de toutes les pièces audio : la perdre rend le stockage
définitivement muet (§9.13).

```bash
cd /opt/voxecho/deploy
cp .env.prod.example .env
chmod 600 .env

python3 - <<'PY'
import re, secrets, base64, pathlib
p = pathlib.Path('.env'); s = p.read_text()
def pose(cle, valeur):
    global s
    s = re.sub(rf'^{cle}=.*$', f'{cle}={valeur}', s, flags=re.M)
b64 = lambda n: base64.b64encode(secrets.token_bytes(n)).decode()
pose('POSTGRES_PASSWORD', b64(24))
pose('JWT_ACCESS_SECRET', b64(48))
pose('JWT_REFRESH_SECRET', b64(48))
pose('STORAGE_MASTER_KEY', b64(32))
pose('DEMO_ADMIN_PASSWORD', secrets.token_urlsafe(18))
pose('DEMO_AUDITOR_PASSWORD', secrets.token_urlsafe(18))
pose('DEMO_SUPERVISOR_PASSWORD', secrets.token_urlsafe(18))
p.write_text(s)
print('secrets générés')
PY

# Renseigner l'adresse à laquelle Let's Encrypt écrira avant expiration.
sed -i 's|^ACME_EMAIL=.*|ACME_EMAIL=contact@atlastech.cm|' .env
```

**Mettre immédiatement `STORAGE_MASTER_KEY` à l'abri, hors de cette machine.**
Une clé qui ne dort que sur le disque qu'elle protège n'est pas sauvegardée : la
sauvegarde de la base ne la contient pas et ne la contiendra jamais (§9.14).

```bash
grep '^STORAGE_MASTER_KEY=' .env    # à recopier dans le coffre de l'entreprise
```

## 4. Démarrer

```bash
cd /opt/voxecho
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env pull
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env ps
```

L'api applique les migrations à son démarrage. Caddy demande le certificat dès
le premier appel sur le domaine ; le suivre :

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env logs -f caddy
```

## 5. Garnir la démonstration

Le seed dépose des appels dans `INGEST_DIR` : c'est le chemin réel du produit,
contrat §3 compris, qui les range, les empreint et les scelle. Une démonstration
remplie par des insertions directes montrerait des enregistrements que
l'ingestion n'a jamais vus.

Le garnissage tourne dans un service à part, lancé à la demande : les mots de
passe des comptes de démonstration n'ont aucune raison de vivre en permanence
dans l'environnement de l'api.

```bash
cd /opt/voxecho
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env \
  --profile outils run --rm seed
```

Les identifiants des trois comptes sont dans `deploy/.env`
(`DEMO_*_EMAIL`, `DEMO_*_PASSWORD`). Les appels apparaissent dans le portail au
balayage suivant, quelques secondes plus tard.

## 6. Vérifier

```bash
curl -sI https://record.voxecho.cm | head -20          # certificat, HSTS, noindex
curl -s  https://record.voxecho.cm/api/health          # sonde
curl -s  https://record.voxecho.cm/api/instance        # {"demo":true}
curl -sI https://record.voxecho.cm/robots.txt          # Disallow: /
```

Puis, dans le portail : se connecter en auditeur, chercher un appel, l'écouter,
l'exporter, ouvrir le journal — et vérifier que **l'adresse inscrite au journal
est la vôtre**, non celle d'un conteneur (§9.16).

## 7. L'exercice de restauration

Promis en réserve du §9.15, à jouer une fois avant de montrer l'instance à
quiconque — une sauvegarde qu'on n'a jamais essayé de relire n'est pas une
sauvegarde.

```bash
cd /opt/voxecho
C="docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env"

# Prendre, puis vérifier la prise et le stockage.
$C exec api node apps/api/dist/backup/sauvegarde-creer.js
$C exec api node apps/api/dist/backup/sauvegarde-verifier.js --stockage

# Constater que la base rend ce que la prise annonçait.
$C exec api node apps/api/dist/backup/restauration-constater.js
```

Puis emporter une copie de la sauvegarde **hors de l'instance** : elle ne
protège de rien tant qu'elle dort sur le disque qu'elle sauvegarde.

## Mettre à jour

```bash
cd /opt/voxecho && git pull
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env pull
docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env up -d
```

Pour revenir en arrière, figer `VOXECHO_TAG` sur un SHA dans `deploy/.env` et
relancer : les images sont taguées par commit.
