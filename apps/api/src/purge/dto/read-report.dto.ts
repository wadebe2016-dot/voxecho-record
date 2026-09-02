import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { PAGE_SIZE_MAX } from '@voxecho/shared';

/**
 * Lecture d'un rapport. Le filtre `blocked` sépare les deux questions qu'un
 * responsable conformité se pose : « qu'est-ce qui va être détruit ? » et
 * « qu'est-ce qu'une conservation forcée protège ? ».
 */
export class ReadReportDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  /** Un rapport peut compter des milliers de lignes : la page est plus large. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGE_SIZE_MAX)
  pageSize: number = 100;

  @IsOptional()
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean({ message: 'bloqués : true ou false attendu' })
  blocked?: boolean;
}
