import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Motif d'une pose ou d'une levée de conservation forcée. Un hold sans motif
 * lisible ne vaut rien devant un contrôleur : il faudrait retrouver qui l'a
 * posé et lui demander pourquoi.
 */
export class HoldReasonDto {
  @IsString()
  @MinLength(10, { message: 'motif : au moins dix caractères, pas une initiale' })
  @MaxLength(500)
  reason!: string;
}

/**
 * Pose d'une conservation forcée — CLAUDE.md §9.29. La référence du dossier
 * est exigée en plus du motif : « réquisition judiciaire » dit ce qu'on fait,
 * « n° 2026-118 du parquet de Douala » dit de quoi on parle, et c'est cette
 * seconde information qu'un contrôleur demandera.
 */
export class SetHoldDto extends HoldReasonDto {
  @IsString()
  @MinLength(2, { message: 'référence de dossier attendue' })
  @MaxLength(120)
  caseReference!: string;
}

/** Levée d'une conservation forcée. */
export class ReleaseHoldDto extends HoldReasonDto {
  /**
   * Accepte de lever sans contre-validation, quand l'instance n'a qu'un seul
   * administrateur actif (§9.29). Le fait est alors consigné : ce n'est pas
   * une case à cocher pour contourner la règle, c'est la reconnaissance
   * explicite d'une situation qu'on ne peut pas éviter.
   */
  @IsOptional()
  acceptSansContreValidation?: boolean;
}
