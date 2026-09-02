import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX, PURGE_RUN_STATUSES } from '@voxecho/shared';
import type { PurgeRunStatus } from '@voxecho/shared';

export class ListReportsDto {
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
  @IsIn(PURGE_RUN_STATUSES)
  status?: PurgeRunStatus;
}
