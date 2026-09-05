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
 * Périmètre général : ce qui s'applique à défaut de politique plus précise.
 */
export const RETENTION_SCOPE_ALL = 'all';

/**
 * Périmètres reconnus — CLAUDE.md §9.28. Le général, plus une politique par
 * catégorie d'opération : une confirmation de chèque et un ordre de change
 * n'engagent pas la banque de la même façon, et ne relèvent donc pas
 * nécessairement des mêmes durées (§9.10).
 */
export type RetentionScope = string;

/** Une politique, générale ou pour une catégorie d'opération. */
export interface RetentionPolicyEntry {
  appliesTo: RetentionScope;
  days: number;
  /** Motif de dérogation, quand la durée passe sous le plancher (§9.6). */
  belowFloorReason: string | null;
  updatedAt: string;
  /** Faux quand aucune politique n'est enregistrée : c'est le défaut produit. */
  enregistree: boolean;
}

/**
 * L'ensemble des politiques d'un locataire. Une catégorie sans politique
 * propre suit la générale — l'écran le dit plutôt que d'afficher un vide.
 */
export interface RetentionPolicySetResponse {
  generale: RetentionPolicyEntry;
  parCategorie: RetentionPolicyEntry[];
  minDays: number;
}

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
  /**
   * Périmètre visé : `all` ou une catégorie d'opération. Absent, c'est la
   * politique générale qu'on règle.
   */
  appliesTo?: RetentionScope;
}

/** Conservation forcée d'un enregistrement. */
export interface LegalHoldResponse {
  id: string;
  recordingId: string;
  reason: string;
  /**
   * Référence du dossier qui justifie la conservation (§9.29). Vide pour les
   * conservations antérieures à cette exigence : le portail affiche alors
   * « non renseignée » plutôt que d'inventer un dossier.
   */
  caseReference: string;
  setByEmail: string;
  at: string;
  releasedAt: string | null;
  releasedByEmail: string | null;
  releaseReason: string | null;
  /** Levée faute d'un second administrateur actif (§9.29). */
  releasedWithoutSecondApproval: boolean;
}

export interface SetLegalHoldRequest {
  reason: string;
  caseReference: string;
}

/**
 * Lever un hold rend l'appel purgeable de nouveau : l'acte se motive comme la
 * pose, et se trace comme elle — et se fait à quatre yeux (§9.29).
 */
export interface ReleaseLegalHoldRequest {
  reason: string;
  /** Assume une levée sans contre-validation, faute d'un second administrateur. */
  acceptSansContreValidation?: boolean;
}
