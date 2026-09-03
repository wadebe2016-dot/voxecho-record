# Capture FreeSWITCH — script post-enregistrement

`post-enregistrement.sh` est l'autre bout du **contrat d'ingestion** (CLAUDE.md
§3). Il s'exécute sur la machine de capture, à la fin de chaque appel
enregistré, et dépose la paire que le portail attend :

```
INGEST_DIR/<slug>/20260901-143012_16778001_1001_699112233.wav
INGEST_DIR/<slug>/20260901-143012_16778001_1001_699112233.json
```

Il ne parle jamais à l'api : ni base, ni jeton, ni route. Il écrit deux
fichiers, et c'est tout ce que la frontière du §3 autorise. En bash, sans
dépendance hors des utilitaires d'un système ordinaire, parce qu'on ne peut pas
supposer Node installé sur un FreeSWITCH de production.

## Usage

```bash
post-enregistrement.sh \
  --fichier /var/lib/freeswitch/recordings/$UUID.wav \
  --locataire banque-cemac \
  --refci 16778001 \
  --poste 1001 \
  --correspondant 699112233 \
  --sens outbound \
  --debut 2026-09-01T14:30:12+01:00 \
  --duree 183 \
  --ingest-dir /data/ingest
```

| Option          | Rôle                                                             |
| --------------- | ---------------------------------------------------------------- |
| `--source`      | `cucm-bib` (défaut), `siprec`                                    |
| `--categorie`   | `confirmation_cheque`, `operation_change`, `autre` — facultative |
| `--staging-dir` | Répertoire de préparation, voisin d'`INGEST_DIR` par défaut      |
| `--garder`      | Copie le wav au lieu de le déplacer                              |
| `--simulation`  | Affiche ce qui serait déposé, sans rien écrire                   |

## Intégration au dialplan

L'enregistrement doit être en **PCM 8 kHz** : le script refuse tout le reste,
parce que le portail le refuserait aussi.

```xml
<extension name="voxecho-enregistrement">
  <condition field="destination_number" expression="^(\d{4})$">
    <action application="set" data="record_sample_rate=8000"/>
    <action application="set" data="RECORD_STEREO=false"/>
    <action application="set" data="voxecho_fichier=/var/lib/freeswitch/recordings/${uuid}.wav"/>
    <action application="record_session" data="${voxecho_fichier}"/>
    <action application="set" data="api_hangup_hook=system /opt/voxecho/post-enregistrement.sh
      --fichier ${voxecho_fichier}
      --locataire banque-cemac
      --refci ${uuid}
      --poste ${caller_id_number}
      --correspondant ${destination_number}
      --sens outbound
      --debut ${strftime(%Y-%m-%dT%H:%M:%S%z)}
      --duree ${billsec}
      --ingest-dir /data/ingest"/>
  </condition>
</extension>
```

Le décalage rendu par `strftime(%z)` s'écrit `+0100` là où le contrat attend
`+01:00` : insérer les deux-points, ou fournir l'horodatage depuis un script
d'appel. C'est le seul point du dialplan où une erreur de forme est probable, et
le script la refuse plutôt que de la laisser passer.

## Ce qu'il refuse, et pourquoi

Un dépôt mal formé n'est pas perdu : le portail le met en quarantaine avec un
événement d'audit, et il faut le reprendre à la main. Le script préfère donc
échouer bruyamment, pendant que l'appel est encore frais — fréquence
d'échantillonnage, wav tronqué au regard de la durée annoncée, horodatage sans
fuseau, sens ou catégorie hors contrat, locataire qui ne peut pas être un nom de
répertoire, option inconnue (un dialplan qui croit passer une information que le
script ne lit pas doit s'en apercevoir).

Il refuse aussi d'écraser un dépôt du même radical qui attend encore son
ingestion. Le redépôt d'un appel **déjà ingéré**, lui, est reconnu par le
portail : dépôt identique retiré et tracé, empreinte différente mise en
quarantaine — la preuve déjà rangée n'est jamais écrasée (§3).

## Ce qui n'est pas ici

Le transport entre le site de capture et le portail (WireGuard ou autre), le
profil SIP récepteur et l'approvisionnement CUCM par AXL relèvent du **kit de
branchement**, et non de ce contrat. Ils ne peuvent être validés qu'avec le
CUCM sous la main.

## Tests

```bash
pnpm --filter @voxecho/freeswitch test
```

Le dépôt produit est relu par les validateurs du contrat eux-mêmes
(`parseRadical`, `parseIngestMetadata`, `readWavHeader`), et
`apps/api/test/capture-freeswitch.spec.ts` le fait ingérer par le portail : le
§7 promet qu'au branchement réel, aucun changement ne sera nécessaire dans
`apps/`, et c'est là que cette promesse se vérifie.
