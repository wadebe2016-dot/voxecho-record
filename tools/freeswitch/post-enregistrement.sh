#!/usr/bin/env bash
#
# Script post-enregistrement FreeSWITCH — VoxEcho Record, contrat §3.
#
# Appelé à la fin de chaque appel enregistré, il dépose la paire wav+json que
# le portail attend :
#
#   INGEST_DIR/<slug>/20260901-143012_16778001_1001_699112233.wav
#   INGEST_DIR/<slug>/20260901-143012_16778001_1001_699112233.json
#
# Il ne parle jamais à l'api, ne connaît ni la base ni le stockage : il écrit
# des fichiers, et c'est tout ce que la frontière du §3 autorise. Il tourne
# sur la machine de capture, où l'on ne peut pas supposer Node installé — d'où
# le bash, et aucune dépendance hors des utilitaires d'un système ordinaire.
#
# Il refuse plutôt que de deviner. Un dépôt mal formé partirait en quarantaine
# côté portail, avec un événement d'audit et un fichier à reprendre à la main :
# mieux vaut échouer ici, bruyamment, pendant que l'appel est encore frais.
#
# Voir tools/freeswitch/README.md pour l'intégration au dialplan.

set -euo pipefail

readonly PROGRAMME="${0##*/}"
readonly TAUX_ATTENDU=8000
readonly TOLERANCE_DUREE_SEC=2

erreur() {
  echo "$PROGRAMME : $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
Usage : post-enregistrement.sh --fichier <wav> --locataire <slug> \
          --refci <id> --poste <numéro> --correspondant <numéro> \
          --sens <outbound|inbound|internal> --debut <ISO8601 avec fuseau> \
          --duree <secondes> [--source <cucm-bib|siprec>] \
          [--categorie <confirmation_cheque|operation_change|autre>] \
          [--ingest-dir <chemin>] [--staging-dir <chemin>] \
          [--garder] [--simulation]

  --garder      copie le wav au lieu de le déplacer (le laisse à FreeSWITCH)
  --simulation  affiche ce qui serait déposé, sans rien écrire
USAGE
  exit 2
}

# ─── Lecture des arguments ─────────────────────────────────────────────────
fichier=""
locataire=""
refci=""
poste=""
correspondant=""
sens=""
debut=""
duree=""
source="cucm-bib"
categorie=""
ingest_dir="${INGEST_DIR:-}"
staging_dir="${VOXECHO_STAGING_DIR:-}"
garder=0
simulation=0

while [ $# -gt 0 ]; do
  case "$1" in
    --fichier) fichier="${2:-}"; shift 2 ;;
    --locataire) locataire="${2:-}"; shift 2 ;;
    --refci) refci="${2:-}"; shift 2 ;;
    --poste) poste="${2:-}"; shift 2 ;;
    --correspondant) correspondant="${2:-}"; shift 2 ;;
    --sens) sens="${2:-}"; shift 2 ;;
    --debut) debut="${2:-}"; shift 2 ;;
    --duree) duree="${2:-}"; shift 2 ;;
    --source) source="${2:-}"; shift 2 ;;
    --categorie) categorie="${2:-}"; shift 2 ;;
    --ingest-dir) ingest_dir="${2:-}"; shift 2 ;;
    --staging-dir) staging_dir="${2:-}"; shift 2 ;;
    --garder) garder=1; shift ;;
    --simulation) simulation=1; shift ;;
    -h|--help) usage ;;
    # Une option inconnue n'est pas ignorée : elle signale un dialplan qui
    # croit passer une information que ce script ne lit pas.
    *) erreur "option inconnue : $1" ;;
  esac
done

# ─── Validation des métadonnées ────────────────────────────────────────────
# Les motifs sont ceux du contrat (packages/shared/src/ingestion) : ce qui est
# refusé ici est exactement ce que le portail mettrait en quarantaine.
readonly MOTIF_SLUG='^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$'
readonly MOTIF_TELEPHONIQUE='^[A-Za-z0-9+.-]{1,64}$'
readonly MOTIF_ISO='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'

[ -n "$fichier" ] || usage
[ -n "$locataire" ] || usage
[ -n "$refci" ] || usage
[ -n "$poste" ] || usage
[ -n "$correspondant" ] || usage
[ -n "$sens" ] || usage
[ -n "$debut" ] || usage
[ -n "$duree" ] || usage
[ -n "$ingest_dir" ] || erreur "--ingest-dir (ou INGEST_DIR) est requis"

[[ "$locataire" =~ $MOTIF_SLUG ]] ||
  erreur "locataire « $locataire » : minuscules, chiffres et tirets — c'est un nom de répertoire"
for champ in refci poste correspondant; do
  valeur="${!champ}"
  [[ "$valeur" =~ $MOTIF_TELEPHONIQUE ]] ||
    erreur "$champ « $valeur » : caractères non autorisés par le contrat §3"
done
case "$sens" in
  outbound|inbound|internal) ;;
  *) erreur "sens « $sens » : outbound, inbound ou internal" ;;
esac
case "$source" in
  cucm-bib|siprec|simulator) ;;
  *) erreur "source « $source » : cucm-bib, siprec ou simulator" ;;
esac
if [ -n "$categorie" ]; then
  # Une catégorie inconnue part en quarantaine côté portail (§9.10) : une
  # valeur que personne n'a déclarée est une faute de frappe jusqu'à preuve
  # du contraire. Autant la refuser ici.
  case "$categorie" in
    confirmation_cheque|operation_change|autre) ;;
    *) erreur "catégorie « $categorie » inconnue du contrat §3" ;;
  esac
fi
[[ "$debut" =~ $MOTIF_ISO ]] ||
  erreur "début « $debut » : horodatage ISO 8601 avec fuseau attendu (2026-09-01T14:30:12+01:00)"
[[ "$duree" =~ ^[0-9]+$ ]] || erreur "durée « $duree » : un entier de secondes"
[ "$duree" -le 86400 ] || erreur "durée « $duree » : au-delà de 24 h, c'est une erreur de mesure"

# ─── Contrôle du fichier audio ─────────────────────────────────────────────
[ -f "$fichier" ] || erreur "fichier introuvable : $fichier"
[ -r "$fichier" ] || erreur "fichier illisible : $fichier"

octets=$(wc -c <"$fichier")
[ "$octets" -gt 44 ] || erreur "wav vide ou tronqué ($octets octets)"

# En-tête RIFF/WAVE lu à la main : od est partout, sox ne l'est pas.
entete=$(od -An -tx1 -N 44 -v "$fichier" | tr -d ' \n')
lire_octets() { # <offset en octets> <longueur> → entier petit-boutiste
  local debut_hex=$(( $1 * 2 )) longueur=$(( $2 * 2 )) morceau valeur=0 i
  morceau="${entete:$debut_hex:$longueur}"
  for (( i = ${#morceau} - 2; i >= 0; i -= 2 )); do
    valeur=$(( valeur * 256 + 16#${morceau:$i:2} ))
  done
  echo "$valeur"
}

[ "${entete:0:8}" = "52494646" ] || erreur "en-tête RIFF absent : $fichier n'est pas un WAV"
[ "${entete:16:8}" = "57415645" ] || erreur "en-tête WAVE absent : $fichier n'est pas un WAV"

format=$(lire_octets 20 2)
canaux=$(lire_octets 22 2)
taux=$(lire_octets 24 4)
bits=$(lire_octets 34 2)

[ "$format" -eq 1 ] || erreur "wav non PCM (format $format) : le contrat §3 attend du PCM"
[ "$taux" -eq "$TAUX_ATTENDU" ] ||
  erreur "wav à $taux Hz : le contrat §3 attend ${TAUX_ATTENDU} Hz (régler record_sample_rate=8000)"
[ "$canaux" -ge 1 ] || erreur "nombre de canaux invalide ($canaux)"
if [ "$bits" -lt 8 ] || [ $(( bits % 8 )) -ne 0 ]; then
  erreur "résolution $bits bits invalide"
fi

# Durée réelle, confrontée à celle annoncée : c'est le contrôle que fera le
# portail, et le seul moyen de repérer ici un enregistrement tronqué.
donnees=$(( octets - 44 ))
par_seconde=$(( taux * canaux * (bits / 8) ))
[ "$par_seconde" -gt 0 ] || erreur "en-tête wav incohérent"
duree_reelle=$(( donnees / par_seconde ))
ecart=$(( duree_reelle - duree ))
if [ "$ecart" -lt 0 ]; then ecart=$(( -ecart )); fi
[ "$ecart" -le "$TOLERANCE_DUREE_SEC" ] ||
  erreur "durée annoncée ${duree} s, audio de ${duree_reelle} s : enregistrement tronqué ?"

# ─── Nommage ───────────────────────────────────────────────────────────────
# Le radical porte l'heure **locale du producteur**, telle qu'elle est écrite
# dans l'horodatage : c'est elle qu'un contrôleur lit dans le nom du fichier,
# et c'est elle qui range la preuve dans le bon mois. Aucune conversion de
# fuseau, donc — la chaîne ISO fait foi.
radical="${debut:0:4}${debut:5:2}${debut:8:2}-${debut:11:2}${debut:14:2}${debut:17:2}_${refci}_${poste}_${correspondant}"

destination="$ingest_dir/$locataire"
cible_wav="$destination/$radical.wav"
cible_json="$destination/$radical.json"

if [ "$simulation" -eq 1 ]; then
  echo "$PROGRAMME : déposerait $cible_wav (${duree_reelle} s, $octets octets)"
  exit 0
fi

# Un dépôt du même radical attend peut-être déjà son ingestion : on ne le
# remplace pas sous les pieds du portail. Le redépôt légitime d'un fichier
# déjà rangé est traité par le portail, qui sait le reconnaître (§3).
if [ -e "$cible_wav" ] || [ -e "$cible_json" ]; then
  erreur "dépôt déjà présent pour $radical : ne rien écraser sous les pieds de l'ingestion"
fi

# ─── Dépôt ─────────────────────────────────────────────────────────────────
# Les fichiers sont préparés hors d'INGEST_DIR puis déplacés : un fichier
# temporaire déposé sous surveillance partirait en quarantaine, le portail ne
# reconnaissant que .wav et .json. Le répertoire de préparation est voisin
# d'INGEST_DIR pour que `mv` reste atomique — un renommage sur le même
# système de fichiers ne peut pas être vu à moitié.
if [ -z "$staging_dir" ]; then
  staging_dir="$(dirname "$ingest_dir")/.voxecho-staging"
fi
mkdir -p "$staging_dir" "$destination"

travail=$(mktemp -d "$staging_dir/depot.XXXXXX")
nettoyer() { rm -rf "$travail"; }
trap nettoyer EXIT

if [ "$garder" -eq 1 ]; then
  cp -- "$fichier" "$travail/$radical.wav"
else
  # `mv` d'abord, `cp` en repli : FreeSWITCH peut enregistrer sur un autre
  # volume que le répertoire d'ingestion.
  mv -- "$fichier" "$travail/$radical.wav" 2>/dev/null ||
    { cp -- "$fichier" "$travail/$radical.wav" && rm -f -- "$fichier"; }
fi

categorie_json=""
if [ -n "$categorie" ]; then
  categorie_json="
  \"category\": \"$categorie\","
fi

cat >"$travail/$radical.json" <<JSON
{
  "schema": 1,
  "refci": "$refci",
  "near": "$poste",
  "far": "$correspondant",
  "direction": "$sens",
  "startedAt": "$debut",
  "durationSec": $duree,$categorie_json
  "source": "$source"
}
JSON

# L'ordre est le contrat : le wav d'abord, le json en dernier. C'est le json
# qui ferme la paire et déclenche l'ingestion.
mv -- "$travail/$radical.wav" "$cible_wav"
mv -- "$travail/$radical.json" "$cible_json"

echo "$PROGRAMME : déposé $cible_wav (${duree_reelle} s, $octets octets)"
