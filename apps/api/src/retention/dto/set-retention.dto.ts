import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { RETENTION_DAYS_MAX, RETENTION_DAYS_MIN } from '@voxecho/shared';

/** Changement de la politique de conservation — CLAUDE.md §9.6. */
export class SetRetentionDto {
  @Type(() => Number)
  @IsInt()
  @Min(RETENTION_DAYS_MIN, { message: `jours : ${RETENTION_DAYS_MIN} au minimum` })
  @Max(RETENTION_DAYS_MAX, { message: `jours : ${RETENTION_DAYS_MAX} au maximum` })
  days!: number;

  /**
   * Motif d'une conservation plus courte que le plancher de l'instance.
   * Exigé sous le plancher, refusé au-dessus — le service tranche, car lui
   * seul connaît le plancher configuré.
   */
  @IsOptional()
  @IsString()
  @MinLength(10, { message: 'motif : au moins dix caractères, pas une initiale' })
  @MaxLength(500)
  belowFloorReason?: string;

  /**
   * Périmètre visé : `all` ou une catégorie d'opération (§9.28). Le service
   * tranche ce qui est reconnu — lui seul connaît le catalogue.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  appliesTo?: string;
}
