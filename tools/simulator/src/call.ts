import { buildRadical, type IngestDirection, type IngestMetadata } from '@voxecho/shared';
import type { Alea } from './random';

/**
 * Fabrication d'appels plausibles — CLAUDE.md §4.
 *
 * « Plausible » veut dire : ce qu'un contrôleur COBAC s'attendrait à lire
 * dans un journal de banque camerounaise. Des numéros à neuf chiffres
 * commençant par 6, des postes internes à quatre chiffres, des appels en
 * heures ouvrées, une majorité de conversations courtes.
 */

/** Préfixes mobiles camerounais (MTN, Orange, Nexttel). */
const PREFIXES_MOBILES = ['65', '66', '67', '69', '62'] as const;

/** Le fuseau du produit : Africa/Douala, UTC+1, sans heure d'été. */
export const DECALAGE_DOUALA = '+01:00';

/** Postes enregistrés du plateau : agence, guichet, direction. */
const POSTES = ['1001', '1002', '1003', '1010', '1042', '2001', '2002'] as const;

export interface OptionsAppel {
  /** Jour de l'appel. Par défaut, un jour ouvré tiré au sort dans le passé récent. */
  jour?: Date;
}

/** Numéro mobile camerounais : 6XXXXXXXX. */
export function numeroMobile(alea: Alea): string {
  const prefixe = alea.parmi(PREFIXES_MOBILES);
  let reste = '';
  for (let index = 0; index < 7; index += 1) reste += String(alea.entier(0, 9));
  return `${prefixe}${reste}`;
}

/**
 * Durée d'appel en secondes, entre 15 s et 10 min comme le demande le §4.
 * La loi est volontairement déséquilibrée : la plupart des appels de guichet
 * durent moins d'une minute, quelques dossiers s'éternisent. Une loi uniforme
 * donnerait des heures d'audio et une démonstration invraisemblable.
 */
export function dureeSecondes(alea: Alea): number {
  if (alea.chance(0.65)) return alea.entier(15, 75); // l'ordinaire
  if (alea.chance(0.8)) return alea.entier(76, 240); // un dossier à instruire
  return alea.entier(241, 600); // le litige du jour
}

/** Un instant en heures ouvrées : jours de semaine, 8 h – 18 h. */
export function instantOuvre(alea: Alea, jour: Date): Date {
  const date = new Date(jour);
  // Samedi et dimanche : on recule au vendredi, l'agence était fermée.
  const jourSemaine = date.getUTCDay();
  if (jourSemaine === 6) date.setUTCDate(date.getUTCDate() - 1);
  if (jourSemaine === 0) date.setUTCDate(date.getUTCDate() - 2);
  date.setUTCHours(alea.entier(8, 17), alea.entier(0, 59), alea.entier(0, 59), 0);
  return date;
}

/**
 * Horodatage ISO avec décalage explicite, tel que l'exige le contrat §3.
 * `jour` porte déjà l'heure locale de Douala : on l'écrit telle quelle et on
 * y accole le décalage, sans repasser par UTC.
 */
export function horodatageLocal(local: Date): string {
  const pad = (valeur: number, taille = 2): string => String(valeur).padStart(taille, '0');
  const date = `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const heure = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  return `${date}T${heure}${DECALAGE_DOUALA}`;
}

export interface AppelSimule {
  readonly metadata: IngestMetadata;
  readonly radical: string;
}

/** Tire un appel complet : métadonnées conformes au contrat et son radical. */
export function genererAppel(alea: Alea, options: OptionsAppel = {}): AppelSimule {
  const jour = options.jour ?? new Date();
  const debut = instantOuvre(alea, jour);

  // Un appel interne relie deux postes ; les autres, un poste et un mobile.
  const direction: IngestDirection = alea.chance(0.08)
    ? 'internal'
    : alea.chance(0.55)
      ? 'inbound'
      : 'outbound';

  const near = alea.parmi(POSTES);
  let far = direction === 'internal' ? alea.parmi(POSTES) : numeroMobile(alea);
  while (direction === 'internal' && far === near) far = alea.parmi(POSTES);

  const metadata: IngestMetadata = {
    schema: 1,
    refci: String(alea.entier(10_000_000, 99_999_999)),
    near,
    far,
    direction,
    startedAt: horodatageLocal(debut),
    durationSec: dureeSecondes(alea),
    source: 'simulator',
  };

  return { metadata, radical: buildRadical(metadata) };
}
