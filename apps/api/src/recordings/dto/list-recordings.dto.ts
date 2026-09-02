import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  RECORDING_SORT_FIELDS,
  SORT_ORDERS,
} from '@voxecho/shared';
import type { RecordingSortField, SortOrder } from '@voxecho/shared';

/**
 * Pagination serveur. Les filtres de recherche (numéro, plage de dates,
 * direction, durée) arrivent en S3 ; la pagination et le tri sont posés dès
 * maintenant pour que le portail n'ait pas à changer de contrat.
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
}
