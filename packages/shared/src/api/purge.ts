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

  /** Politique générale appliquée, et date d'échéance qui en découle. Toutes deux figées. */
  policyDays: number;
  cutoff: string;

  /**
   * Toutes les durées figées, par périmètre — CLAUDE.md §9.28. `policyDays`
   * seul ne dirait que la générale : un rapport où les ordres de change
   * relèvent de dix ans et le reste de deux se lirait comme un rapport à deux
   * ans. C'est ce document que l'exécution rejoue.
   */
  policyByScope: Record<string, number>;

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

  /**
   * Empreinte du certificat de destruction, figée à l'instant de la
   * destruction (§9.31). Nulle tant que le rapport n'a rien détruit : il
   * n'existe pas de certificat pour une destruction qui n'a pas eu lieu.
   */
  certificateSha256: string | null;
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
  /**
   * Catégorie d'opération, figée : elle décide de la durée applicable (§9.28).
   * Nulle sur un rapport établi avant que le rapport ne la retienne — on ne
   * lui en invente pas une.
   */
  operationCategory: string | null;
  /** Durée de conservation qui a jugé cette pièce, en jours. Nulle de même. */
  policyDays: number | null;
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
