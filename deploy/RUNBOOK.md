# Runbook — mise en service de `record.voxecho.cm`

Trente étapes, dans l'ordre, à exécuter sur l'instance de démonstration
(`voxecho-demo`, Ubuntu 24.04, t3.small, `15.188.164.226`) en utilisateur
`ubuntu` via EC2 Instance Connect.

Le pourquoi de chaque choix est en §9.18 de `CLAUDE.md` ; ce document ne contient
que le geste.

## Avant de commencer

- **La CI doit être verte sur `main`.** C'est elle qui publie les images sur
  GHCR : sans elle, l'étape 17 ne trouve rien à tirer. Les images ne sont jamais
  construites sur l'instance — 2 Go de mémoire n'y suffiraient pas.
- **Les ports 80 et 443 doivent être ouverts** dans le groupe de sécurité. Sans
  le 80, Caddy ne peut pas obtenir son certificat : le challenge HTTP-01 échoue
  sans que rien ne le dise côté navigateur.
- **`record.voxecho.cm` doit pointer sur l'instance en « DNS only »** (nuage
  gris). C'est volontaire : les conversations ne transitent par aucun
  intermédiaire qui les déchiffrerait au passage.

## Légende

| Marque | Sens                                                                   |
| ------ | ---------------------------------------------------------------------- |
| **T**  | nécessite le jeton GitHub (dépôt et images privés)                     |
| **→**  | sortie à conserver et à transmettre                                    |
| **×**  | sortie secrète : ne la coller nulle part, ne la transmettre à personne |

Le jeton est un _fine-grained token_ GitHub avec lecture du dépôt et
`read:packages`. Il ne sert qu'aux étapes 10, 11 et 17.

---

## Préparation de la machine (1 à 8)

Deux gigaoctets de mémoire, quatre conteneurs et un pic à la migration : le
fichier d'échange n'est pas un luxe.

**1.**

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
```

**2.**

```bash
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**3.**

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl git
```

**4.**

```bash
sudo install -m 0755 -d /etc/apt/keyrings && sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc && sudo chmod a+r /etc/apt/keyrings/docker.asc
```

**5.**

```bash
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

**6.**

```bash
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

**7.**

```bash
sudo usermod -aG docker ubuntu
```

**8.** — **Fermer la session Instance Connect et se reconnecter** : le groupe
`docker` ne prend effet qu'à l'ouverture d'une nouvelle session. Puis vérifier
que le démon répond sans `sudo` : **→**

```bash
docker version --format '{{.Server.Version}}'
```

## Dépôt et registre (9 à 11)

**9.**

```bash
sudo mkdir -p /opt/voxecho && sudo chown ubuntu:ubuntu /opt/voxecho && cd /opt/voxecho
```

**10. — T** — la saisie du jeton est masquée ; il reste en variable de session
jusqu'à l'étape 11, qui l'efface.

```bash
read -rsp 'Jeton GitHub : ' GH_TOKEN && echo
git clone https://wadebe2016-dot:${GH_TOKEN}@github.com/wadebe2016-dot/voxecho-record.git .
```

**11. — T →**

```bash
echo "$GH_TOKEN" | docker login ghcr.io -u wadebe2016-dot --password-stdin && unset GH_TOKEN
```

## Secrets (12 à 15)

Aucun de ces secrets ne revient dans le dépôt.

**12.**

```bash
cd /opt/voxecho/deploy && cp .env.prod.example .env && chmod 600 .env
```

**13.**

```bash
python3 - <<'PY'
import re, secrets, base64, pathlib
p = pathlib.Path('.env'); s = p.read_text()
def pose(c, v):
    global s
    s = re.sub(rf'^{c}=.*$', f'{c}={v}', s, flags=re.M)
b64 = lambda n: base64.b64encode(secrets.token_bytes(n)).decode()
# POSTGRES_PASSWORD sans / ni + : le produit encode désormais l'URL (§9.19),
# mais ce mot de passe se retrouve aussi dans psql, pg_dump et les journaux,
# où un caractère gênant se paie en échappements oubliés.
pose('POSTGRES_PASSWORD', secrets.token_urlsafe(24)); pose('JWT_ACCESS_SECRET', b64(48))
pose('JWT_REFRESH_SECRET', b64(48)); pose('STORAGE_MASTER_KEY', b64(32))
for r in ('ADMIN','AUDITOR','SUPERVISOR'): pose(f'DEMO_{r}_PASSWORD', secrets.token_urlsafe(18))
p.write_text(s); print('secrets générés')
PY
```

**14.** — remplacer par l'adresse à laquelle Let's Encrypt écrira avant
l'expiration d'un certificat.

```bash
sed -i 's|^ACME_EMAIL=.*|ACME_EMAIL=TON_ADRESSE@exemple.cm|' .env
```

**15. — ×** — la clé maître, à recopier **immédiatement** dans le coffre de
l'entreprise, hors de cette machine. Une clé qui ne dort que sur le disque
qu'elle protège n'est pas sauvegardée : la sauvegarde de la base ne la contient
pas, et ne la contiendra jamais (§9.14).

```bash
grep '^STORAGE_MASTER_KEY=' .env
```

## Démarrage (16 à 20)

**16.** — le raccourci `C` ne survit pas à une déconnexion : le redéfinir à
chaque nouvelle session.

```bash
cd /opt/voxecho && C="docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env"
```

**17. — T →** — utilise l'authentification de l'étape 11.

```bash
$C pull
```

**18.**

```bash
$C up -d
```

**19. — →** — les quatre services doivent être `running`, `db` et `api` en
`healthy`.

```bash
$C ps
```

**20. — →** — obtention du certificat. `Ctrl-C` pour sortir du suivi.

```bash
$C logs --tail 40 caddy
```

## Garnissage (21 à 22)

**21. — →** — le garnissage tourne dans un service à part, lancé à la demande :
les mots de passe des comptes de démonstration n'ont aucune raison de vivre en
permanence dans l'environnement de l'api. La sortie n'affiche que les adresses.

Les appels sont **déposés dans `INGEST_DIR`**, comme le fera la capture : c'est
l'ingestion du produit qui les range, les empreint et les scelle. Ils
apparaissent dans le portail au balayage suivant, quelques secondes plus tard.

```bash
$C --profile outils run --rm seed
```

**22. — ×** — les identifiants des trois comptes, pour se connecter au portail.

```bash
grep '^DEMO_' deploy/.env
```

## Vérifications (23 à 27)

**23. — →** — doit montrer `strict-transport-security`,
`content-security-policy` et `x-robots-tag`.

```bash
curl -sI https://record.voxecho.cm | head -20
```

**24. — →**

```bash
curl -s https://record.voxecho.cm/api/health && echo
```

**25. — →** — attendu : `{"demo":true}`. C'est ce qui déclenche la mention
« instance de démonstration » sur l'écran de connexion.

```bash
curl -s https://record.voxecho.cm/api/instance && echo
```

**26. — →**

```bash
curl -s https://record.voxecho.cm/robots.txt
```

**27. — → (la plus importante)** — dans le navigateur : se connecter en
auditeur, écouter un appel, ouvrir le journal d'audit. Puis, ici, vérifier
**quelle adresse a été inscrite au journal** :

```bash
$C exec -T db psql -U voxecho -d voxecho -c "select action, ip, at from audit_events where action in ('LOGIN','LISTEN') order by at desc limit 5;"
```

La colonne `ip` doit porter **l'adresse du poste depuis lequel on s'est
connecté**. Une adresse en `172.x` ou `10.x` est celle d'un conteneur : la
chaîne Caddy → nginx → api n'a pas transmis la vraie, et `TRUSTED_PROXIES` est à
ajuster. C'est le défaut corrigé au §9.16, et le déploiement est le seul endroit
où il peut revenir — un journal d'audit qui attribue toutes les consultations à
la même adresse ne prouve plus rien.

## Exercice de restauration (28 à 30)

À jouer **avant de montrer l'instance à quiconque**. Une sauvegarde qu'on n'a
jamais essayé de relire n'est pas une sauvegarde, c'est une intention (§9.14).

**28. — →**

```bash
$C exec api node apps/api/dist/backup/sauvegarde-creer.js
```

**29. — →** — doit finir sur « Aucune anomalie constatée ».

```bash
$C exec api node apps/api/dist/backup/sauvegarde-verifier.js --stockage
```

**30. — →** — doit finir sur « La base restaurée rend exactement ce que la prise
annonçait ».

```bash
$C exec api node apps/api/dist/backup/restauration-constater.js
```

Puis emporter une copie de la sauvegarde **hors de l'instance** : elle ne
protège de rien tant qu'elle dort sur le disque qu'elle sauvegarde.

---

## En cas de problème

| Symptôme                                    | Cause la plus fréquente                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `pull` : `denied` ou `unauthorized`         | Étape 11 non faite, ou jeton sans `read:packages`                  |
| `pull` : `manifest unknown`                 | La CI n'a pas encore publié les images pour ce commit              |
| Caddy boucle sur des erreurs ACME           | Port 80 fermé, ou DNS pas encore propagé                           |
| `api` en `unhealthy`                        | `$C logs api` — le plus souvent une variable manquante dans `.env` |
| Journal d'audit avec des adresses en `172.` | `TRUSTED_PROXIES` : voir l'étape 27                                |

## Mettre à jour

```bash
cd /opt/voxecho && git pull
$C pull && $C up -d
```

Pour revenir en arrière, figer `VOXECHO_TAG` sur un SHA de commit dans
`deploy/.env` et relancer : les images sont taguées par commit, il n'y a rien à
reconstruire.
