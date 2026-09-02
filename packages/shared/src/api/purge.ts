/**
 * Purge — CLAUDE.md §5 et §9.7.
 *
 * Rien ne se détruit sans avoir été énuméré d'abord. Une simulation produit un
 * **rapport** : la liste des appels échus, ce qu'ils pèsent, et ceux qu'une
 * conservation forcée épargne. C'est ce document qu'un responsable conformité
 * lit et valide ; l'exécution le désigne ensuite par son identifiant, et
 * refuse si la réalité ne lui correspond plus.
 */

export const PURGE_RUN_STATUSES = ['simulated', 'executed', 'cancelled'] as const;
export type PurgeRunStatus = (typeof PURGE_RUN_STATUSES)[number];

export const PURGE_ITEM_OUTCOMES = ['candidate', 'purged', 'blocked', 'missing'] as const;
export type PurgeItemOutcome = (typeof PURGE_ITEM_OUTCOMES)[number];

/** En-tête d'un rapport : ce qu'un responsable conformité lit en premier. */
export interface PurgeReportSummary {
  id: string;
  status: PurgeRunStatus;

  /** Politique appliquée, et date d'échéance qui en découle. Toutes deux figées. */
  policyDays: number;
  cutoff: string;

  /** Ce qui serait détruit. */
  candidateCount: number;
  candidateBytes: number;

  /** Ce qu'une conservation forcée épargne. */
  blockedCount: number;
  blockedBytes: number;

  createdByEmail: string;
  createdAt: string;

  executedByEmail: string | null;
  executedAt: string | null;
  purgedCount: number | null;
  purgedBytes: number | null;

  cancelledByEmail: string | null;
  cancelledAt: string | null;
}

/** Une ligne du rapport, telle qu'elle était au moment de la décision. */
export interface PurgeReportItem {
  recordingId: string;
  refci: string;
  near: string;
  far: string;
  startedAt: string;
  durationSec: number;
  sizeBytes: number;
  sha256: string;
  outcome: PurgeItemOutcome;
  /** Une conservation forcée épargnait-elle cet appel ? */
  blocked: boolean;
  /** Motif du hold qui bloque, pour que le rapport se lise sans autre source. */
  blockingReason: string | null;
}

export interface PurgeReportDetail extends PurgeReportSummary {
  items: PurgeReportItem[];
  itemsTotal: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/**
 * Exécution d'un rapport. Le motif n'est pas une formalité : détruire des
 * pièces probantes est le seul acte irréversible du produit.
 */
export interface ExecutePurgeRequest {
  reason: string;
}
