import type { IngestDirection, IngestSource } from '../ingestion/contract.js';
import type { RecordingStatus } from '../domain/enums.js';

/**
 * Enregistrement tel que le portail le reçoit. Le SHA-256 est exposé : il est
 * affiché à la réécoute, c'est la preuve d'intégrité montrée au contrôleur.
 */
export interface RecordingListItem {
  id: string;
  refci: string;
  near: string;
  far: string;
  direction: IngestDirection;
  startedAt: string;
  durationSec: number;
  sha256: string;
  sizeBytes: number;
  source: IngestSource;
  status: RecordingStatus;
  /**
   * L'appel est-il sous conservation forcée ? Dérivé de la table
   * `LegalHold` — un hold actif est une ligne non levée — et non recopié
   * dans `status` : deux représentations du même fait finissent par diverger,
   * et le jour où elles divergent, c'est la purge qui arbitre (§9.6).
   */
  underHold: boolean;
}

export const RECORDING_SORT_FIELDS = ['startedAt', 'durationSec'] as const;
export type RecordingSortField = (typeof RECORDING_SORT_FIELDS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

/**
 * Filtres de recherche — CLAUDE.md §6 : « par numéro (near/far), plage de
 * dates, direction, durée min/max ». Tous facultatifs et cumulatifs : un
 * contrôleur affine sa recherche, il ne la reformule pas.
 *
 * Les bornes de dates s'écrivent en date locale (`yyyy-mm-dd`), sans heure.
 * C'est ce qu'un contrôleur saisit, et l'api les convertit en instants de la
 * journée d'Africa/Douala — demander « le 1er septembre » ne doit pas
 * dépendre du fuseau du navigateur.
 */
export interface RecordingFilters {
  /** Numéro cherché, dans le poste enregistré **ou** chez le correspondant. */
  phone?: string;
  /** Premier jour retenu, inclus (`yyyy-mm-dd`, heure locale de Douala). */
  from?: string;
  /** Dernier jour retenu, inclus. */
  to?: string;
  direction?: IngestDirection;
  minDurationSec?: number;
  maxDurationSec?: number;
}

export interface RecordingListQuery extends RecordingFilters {
  page?: number;
  pageSize?: number;
  sort?: RecordingSortField;
  order?: SortOrder;
}

/** Fuseau du produit : fixe, sans heure d'été (CLAUDE.md §1). */
export const TENANT_TIMEZONE_OFFSET = '+01:00';

/** `yyyy-mm-dd`, tel que saisi dans un champ de date. */
export const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Ce jour existe-t-il au calendrier ?
 *
 * `DATE_ONLY_PATTERN` ne juge que la forme, et la forme ment : « 2026-02-30 »
 * et « 2026-09-32 » la respectent tous les deux. Le premier serait reporté au
 * 1er mars sans un mot, le second rendrait une date invalide qui remonterait
 * en erreur serveur. Les deux sont graves pour la même raison : la recherche
 * partirait sur autre chose que ce qui a été demandé, tandis que le journal
 * d'audit consignerait le critère tel qu'il a été saisi. Un journal qui
 * atteste d'une recherche qui n'a pas eu lieu ne vaut rien devant un
 * contrôleur.
 */
export function isCalendarDay(value: string): boolean {
  if (!DATE_ONLY_PATTERN.test(value)) return false;
  const [annee, mois, jour] = value.split('-').map(Number) as [number, number, number];
  // `Date.UTC` normalise en silence — c'est ce report qu'on traque : si l'un
  // des trois champs a bougé, le jour saisi n'existait pas.
  const instant = new Date(Date.UTC(annee, mois - 1, jour));
  return (
    instant.getUTCFullYear() === annee &&
    instant.getUTCMonth() === mois - 1 &&
    instant.getUTCDate() === jour
  );
}

/**
 * Bornes d'un intervalle de jours, en instants. La borne haute couvre la
 * journée entière : chercher « du 1er au 1er » doit rendre les appels du 1er,
 * pas seulement celui de minuit pile.
 *
 * Lève sur un jour inexistant plutôt que de le reporter au suivant. L'appelant
 * est censé avoir validé sa saisie ; s'il ne l'a pas fait, mieux vaut qu'il
 * l'apprenne que de chercher sur une journée que personne n'a demandée.
 */
export function dayRangeToInstants(
  from?: string,
  to?: string,
): {
  gte?: Date;
  lte?: Date;
} {
  const bornes: { gte?: Date; lte?: Date } = {};
  if (from) bornes.gte = jourVersInstant(from, '00:00:00.000');
  if (to) bornes.lte = jourVersInstant(to, '23:59:59.999');
  return bornes;
}

function jourVersInstant(jour: string, heure: string): Date {
  if (!isCalendarDay(jour)) {
    throw new RangeError(`jour inexistant au calendrier : « ${jour} »`);
  }
  return new Date(`${jour}T${heure}${TENANT_TIMEZONE_OFFSET}`);
}
