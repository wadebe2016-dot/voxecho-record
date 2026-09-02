import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { AUDIT_ACTIONS, AUDIT_SCOPES, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '@voxecho/shared';
import type { AuditAction, AuditScope } from '@voxecho/shared';
import { EstJourCalendaire } from '../../common/validators/jour-calendaire';

/**
 * Filtres du journal d'audit — CLAUDE.md §6.
 *
 * Mêmes règles que la recherche d'appels : ce qui n'est pas dans cette liste
 * est refusé, et une borne de date doit exister au calendrier (§9.8 du S3).
 */
export class ListAuditDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGE_SIZE_MAX)
  pageSize: number = PAGE_SIZE_DEFAULT;

  @IsOptional()
  @IsIn(AUDIT_ACTIONS)
  action?: AuditAction;

  /** Fragment d'adresse : un contrôleur cherche « qui », pas un identifiant. */
  @IsOptional()
  @IsString()
  @MaxLength(320)
  actor?: string;

  @IsOptional()
  @IsUUID('4', { message: 'enregistrement : identifiant attendu' })
  recordingId?: string;

  @IsOptional()
  @EstJourCalendaire({
    message: 'du : jour attendu au format aaaa-mm-jj, et existant au calendrier',
  })
  from?: string;

  @IsOptional()
  @EstJourCalendaire({
    message: 'au : jour attendu au format aaaa-mm-jj, et existant au calendrier',
  })
  to?: string;

  /**
   * `tenant` par défaut. `system` et `all` ouvrent sur les événements
   * qu'aucun locataire ne réclame : réservés à l'ADMIN de l'instance (§9.2).
   */
  @IsOptional()
  @IsIn(AUDIT_SCOPES)
  scope?: AuditScope;
}
