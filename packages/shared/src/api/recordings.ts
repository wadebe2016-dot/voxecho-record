import type { IngestDirection, IngestSource } from '../ingestion/contract';
import type { RecordingStatus } from '../domain/enums';

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
 * Bornes d'un intervalle de jours, en instants. La borne haute couvre la
 * journée entière : chercher « du 1er au 1er » doit rendre les appels du 1er,
 * pas seulement celui de minuit pile.
 */
export function dayRangeToInstants(
  from?: string,
  to?: string,
): {
  gte?: Date;
  lte?: Date;
} {
  const bornes: { gte?: Date; lte?: Date } = {};
  if (from) bornes.gte = new Date(`${from}T00:00:00.000${TENANT_TIMEZONE_OFFSET}`);
  if (to) bornes.lte = new Date(`${to}T23:59:59.999${TENANT_TIMEZONE_OFFSET}`);
  return bornes;
}
