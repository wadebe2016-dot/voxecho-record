import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { EstJourCalendaire } from '../../common/validators/jour-calendaire';
import {
  INGEST_DIRECTIONS,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  RECORDING_SORT_FIELDS,
  SORT_ORDERS,
} from '@voxecho/shared';
import type { IngestDirection, RecordingSortField, SortOrder } from '@voxecho/shared';

/**
 * Pagination, tri et filtres de recherche (CLAUDE.md §6).
 *
 * Tout est facultatif et cumulatif. Ce qui n'est pas dans cette liste est
 * refusé par le `ValidationPipe` : une recherche mal formée doit se voir, pas
 * être silencieusement ignorée — sinon le journal d'audit consignerait une
 * recherche que l'auditeur n'a pas faite.
 */
export class ListRecordingsDto {
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
  @IsIn(RECORDING_SORT_FIELDS)
  sort: RecordingSortField = 'startedAt';

  @IsOptional()
  @IsIn(SORT_ORDERS)
  order: SortOrder = 'desc';

  /**
   * Numéro cherché — dans le poste enregistré **ou** chez le correspondant.
   * La correspondance est partielle : un contrôleur cherche souvent un
   * préfixe (« tous les appels vers du 677… ») autant qu'un numéro entier.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9+.-]+$/, { message: 'numéro : caractères non autorisés' })
  phone?: string;

  /**
   * Jour de début, tel qu'un champ de date le produit. Le format ne suffit
   * pas : le jour doit exister au calendrier, sans quoi la recherche porterait
   * sur une autre journée que celle que le journal d'audit consignera.
   */
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

  @IsOptional()
  @IsIn(INGEST_DIRECTIONS)
  direction?: IngestDirection;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(86_400)
  minDurationSec?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(86_400)
  maxDurationSec?: number;
}
