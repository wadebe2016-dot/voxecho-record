import { readFile, stat } from 'node:fs/promises';
import {
  HORLOGE_AGE_CRITIQUE_MS,
  HORLOGE_SEUIL_AVERTISSEMENT_MS,
  HORLOGE_SEUIL_CRITIQUE_MS,
  type EtatHorloge,
} from '@voxecho/shared';

/**
 * État de l'horloge — CLAUDE.md §9.36.
 *
 * L'api lit un **instantané** et ignore qui l'écrit : un conteneur d'appoint en
 * réseau de l'hôte, une tâche planifiée, un opérateur. Parler directement au
 * démon n'était pas possible — son socket de commande est un socket datagramme
 * unix, que `node:dgram` n'ouvre pas — et n'aurait de toute façon lié le
 * produit qu'à une seule façon d'atteindre l'heure.
 *
 * L'instantané est la sortie de `chronyc -c tracking`, une ligne de champs
 * séparés par des virgules. Le format `-c` existe pour être lu par un
 * programme : il ne bouge pas d'une version à l'autre, contrairement au texte.
 */

/** Au-delà, l'instantané ne décrit plus l'heure qu'il est. */
const AGE_MAX_INSTANTANE_MS = 5 * 60 * 1000;

/**
 * Champs de `chronyc -c tracking`, dans l'ordre où chrony les écrit :
 *
 *   0 identifiant de référence   1 adresse de la source   2 stratum
 *   3 **date de référence, en secondes epoch**            4 écart système
 *   5 dernier écart   6 écart quadratique moyen   7 fréquence   8 résiduelle
 *   9 dispersion   10 délai racine   11 dispersion racine   12 intervalle
 *   13 état de saut
 *
 * On ne lit que ceux qui servent ; leur position est le contrat.
 */
const CHAMP_SOURCE = 1;
const CHAMP_STRATUM = 2;
/**
 * Date **absolue** de la dernière référence, en secondes epoch — et non un âge
 * en secondes, ce qu'un premier jet avait supposé. L'erreur donnait une
 * dernière synchronisation en 1970 et un « aucune synchronisation depuis plus
 * de vingt-quatre heures » sur une horloge parfaitement à l'heure.
 */
const CHAMP_DATE_REFERENCE = 3;
const CHAMP_ECART_SYSTEME = 4;
/**
 * État de saut : `Normal`, `Insert second`, `Delete second`, `Not
 * synchronised`. C'est ce que chrony **affirme**, là où le stratum et
 * l'identifiant de référence ne font que le laisser deviner.
 */
const CHAMP_ETAT_SAUT = 13;

export function horlogeIndisponible(message: string): EtatHorloge {
  return {
    statut: 'indisponible',
    source: null,
    decalageMs: null,
    stratum: null,
    derniereSynchro: null,
    releveLe: null,
    message,
  };
}

/**
 * Lit l'instantané et en tire un état.
 *
 * Un instantané absent, illisible ou périmé donne `indisponible` — jamais
 * `non_synchronise`. Le premier dit qu'on n'a pas su lire l'horloge, le second
 * qu'on l'a lue et qu'elle ne suit plus ; seul le second met en cause la valeur
 * probante des horodatages, et lui seul lève le bandeau de la console.
 */
export async function lireHorloge(chemin: string, maintenant = new Date()): Promise<EtatHorloge> {
  let contenu: string;
  let releve: Date;
  try {
    const infos = await stat(chemin);
    releve = infos.mtime;
    contenu = await readFile(chemin, 'utf8');
  } catch {
    return horlogeIndisponible(
      `Aucun relevé d’horloge en ${chemin}. Vérifiez que le service qui l’écrit tourne.`,
    );
  }

  const age = maintenant.getTime() - releve.getTime();
  if (age > AGE_MAX_INSTANTANE_MS) {
    return {
      ...horlogeIndisponible(
        `Le relevé d’horloge date de plus de ${Math.round(age / 60_000)} minutes : il ne décrit plus l’heure qu’il est.`,
      ),
      releveLe: releve.toISOString(),
    };
  }

  const champs = contenu.trim().split('\n')[0]?.split(',') ?? [];
  const source = champs[CHAMP_SOURCE]?.trim() ?? '';
  const ecart = Number(champs[CHAMP_ECART_SYSTEME]);
  const stratum = Number(champs[CHAMP_STRATUM]);
  const dateReference = Number(champs[CHAMP_DATE_REFERENCE]);
  const etatSaut = champs[CHAMP_ETAT_SAUT]?.trim() ?? '';

  if (champs.length < CHAMP_ETAT_SAUT + 1 || !Number.isFinite(ecart)) {
    return {
      ...horlogeIndisponible('Le relevé d’horloge est illisible : il n’a pas la forme attendue.'),
      releveLe: releve.toISOString(),
    };
  }

  const decalageMs = Math.abs(ecart) * 1000;
  // Le champ porte une date, pas une durée : elle se lit telle quelle. Une
  // date à l'epoch signifie que chrony n'a jamais eu de référence.
  const synchroniseeLe =
    Number.isFinite(dateReference) && dateReference > 0 ? new Date(dateReference * 1000) : null;
  const derniereSynchro = synchroniseeLe?.toISOString() ?? null;

  // Ce que chrony affirme l'emporte sur ce qu'on déduirait : « Not
  // synchronised » est sans appel. L'identifiant `7F7F0101` et un stratum nul
  // restent des indices utiles quand l'état de saut manque.
  const orpheline =
    etatSaut === 'Not synchronised' || source === '7F7F0101' || stratum === 0 || source === '';
  const tropVieux =
    synchroniseeLe !== null &&
    maintenant.getTime() - synchroniseeLe.getTime() > HORLOGE_AGE_CRITIQUE_MS;

  if (orpheline || tropVieux || decalageMs > HORLOGE_SEUIL_CRITIQUE_MS) {
    return {
      statut: 'non_synchronise',
      source: orpheline ? null : source,
      decalageMs: Math.round(decalageMs),
      stratum: Number.isFinite(stratum) ? stratum : null,
      derniereSynchro,
      releveLe: releve.toISOString(),
      message: orpheline
        ? 'Le service de temps n’est synchronisé sur aucune source.'
        : tropVieux
          ? 'Aucune synchronisation depuis plus de vingt-quatre heures.'
          : `Décalage de ${Math.round(decalageMs)} ms avec la source de temps.`,
    };
  }

  const derive = decalageMs > HORLOGE_SEUIL_AVERTISSEMENT_MS;
  return {
    statut: derive ? 'derive' : 'synchronise',
    source,
    decalageMs: Math.round(decalageMs),
    stratum: Number.isFinite(stratum) ? stratum : null,
    derniereSynchro,
    releveLe: releve.toISOString(),
    message: derive
      ? `Décalage de ${Math.round(decalageMs)} ms : au-delà du seuil d’avertissement.`
      : `Synchronisée sur ${source}, décalage de ${Math.round(decalageMs)} ms.`,
  };
}
