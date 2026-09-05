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
 * Champs de `chronyc -c tracking`, dans l'ordre où chrony les écrit.
 * On ne lit que ceux qui servent ; leur position est le contrat.
 */
const CHAMP_SOURCE = 1;
const CHAMP_STRATUM = 2;
const CHAMP_DERNIERE_MAJ = 3;
const CHAMP_ECART_SYSTEME = 4;

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
  const depuis = Number(champs[CHAMP_DERNIERE_MAJ]);

  if (source === '' || !Number.isFinite(ecart)) {
    return {
      ...horlogeIndisponible('Le relevé d’horloge est illisible : il n’a pas la forme attendue.'),
      releveLe: releve.toISOString(),
    };
  }

  const decalageMs = Math.abs(ecart) * 1000;
  const depuisMs = Number.isFinite(depuis) ? depuis * 1000 : null;
  const derniereSynchro =
    depuisMs === null ? null : new Date(releve.getTime() - depuisMs).toISOString();

  // Une source qui vaut « 7F7F0101 » est l'adresse dont chrony se sert quand il
  // n'est synchronisé sur rien : la dire telle quelle laisserait croire à une
  // référence de temps.
  const orpheline = source === '7F7F0101' || stratum === 0;
  const tropVieux = depuisMs !== null && depuisMs > HORLOGE_AGE_CRITIQUE_MS;

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
