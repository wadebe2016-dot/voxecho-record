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

export interface RecordingListQuery {
  page?: number;
  pageSize?: number;
  sort?: RecordingSortField;
  order?: SortOrder;
}
