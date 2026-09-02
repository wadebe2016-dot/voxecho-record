/**
 * Rétention et conservation forcée — CLAUDE.md §5 et §9.6.
 *
 * Deux mécanismes opposés se rencontrent ici. La rétention détruit au bout
 * d'un délai ; le legal hold empêche de détruire, sans délai. Quand les deux
 * s'appliquent au même appel, c'est toujours le hold qui gagne : une
 * conservation forcée est ordonnée par quelqu'un, une échéance de rétention
 * n'est qu'un calendrier.
 */

/**
 * Durée de conservation d'un nouveau locataire : 730 jours, soit deux ans.
 * Valeur d'usage bancaire en zone CEMAC ; la référence réglementaire précise
 * reste à confirmer, et la durée est de toute façon réglable par locataire.
 */
export const RETENTION_DAYS_DEFAULT = 730;

/** Une rétention d'un jour est déjà une décision ; zéro n'en est pas une. */
export const RETENTION_DAYS_MIN = 1;

/** Vingt ans : au-delà, c'est une erreur de saisie, pas une politique. */
export const RETENTION_DAYS_MAX = 7300;

/**
 * Seul périmètre reconnu aujourd'hui. La colonne existe pour qu'une politique
 * par sens d'appel ou par service puisse s'ajouter sans migration.
 */
export const RETENTION_SCOPE_ALL = 'all';

/** Politique de conservation en vigueur pour un locataire. */
export interface RetentionPolicyResponse {
  days: number;
  appliesTo: string;
  /**
   * Motif de la dérogation quand `days` passe sous le plancher de l'instance.
   * Nul le reste du temps — sa seule présence signale à un contrôleur qu'il
   * lit une politique dérogatoire.
   */
  belowFloorReason: string | null;
  /** Plancher de l'instance, pour que le portail sache quoi refuser. */
  minDays: number;
  updatedAt: string;
}

/**
 * Changement de politique. Descendre sous le plancher exige un motif écrit :
 * « jamais moins sans décision explicite » (§9.6) suppose que la décision
 * existe quelque part de lisible.
 */
export interface SetRetentionRequest {
  days: number;
  /** Obligatoire si et seulement si `days` passe sous le plancher. */
  belowFloorReason?: string;
}

/** Conservation forcée d'un enregistrement. */
export interface LegalHoldResponse {
  id: string;
  recordingId: string;
  reason: string;
  setByEmail: string;
  at: string;
  releasedAt: string | null;
  releasedByEmail: string | null;
  releaseReason: string | null;
}

export interface SetLegalHoldRequest {
  reason: string;
}

/**
 * Lever un hold rend l'appel purgeable de nouveau : l'acte se motive comme la
 * pose, et se trace comme elle.
 */
export interface ReleaseLegalHoldRequest {
  reason: string;
}
