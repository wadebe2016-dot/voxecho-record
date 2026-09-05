import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

class NtpDto {
  @IsArray()
  @IsString({ each: true })
  serveurs!: string[];

  @IsOptional()
  @IsBoolean()
  applique?: boolean;
}

class DnsDto {
  @IsOptional()
  @IsString()
  primaire!: string | null;

  @IsOptional()
  @IsString()
  secondaire!: string | null;

  @IsOptional()
  @IsString()
  domaineRecherche!: string | null;

  @IsOptional()
  @IsBoolean()
  applique?: boolean;
}

class ProxysDto {
  @IsArray()
  @IsString({ each: true })
  cidr!: string[];
}

class ReglagesReseauDto {
  @IsString()
  fuseau!: string;

  @ValidateNested()
  @Type(() => NtpDto)
  ntp!: NtpDto;

  @ValidateNested()
  @Type(() => DnsDto)
  dns!: DnsDto;

  @ValidateNested()
  @Type(() => ProxysDto)
  proxys!: ProxysDto;
}

/**
 * Écriture de la section réseau. La version lue accompagne la modification :
 * sans elle, deux administrateurs s'écraseraient sans le savoir (§9.36).
 */
export class MajReseauDto {
  @ValidateNested()
  @Type(() => ReglagesReseauDto)
  reglages!: ReglagesReseauDto;

  @IsInt()
  @Min(0)
  version!: number;
}
