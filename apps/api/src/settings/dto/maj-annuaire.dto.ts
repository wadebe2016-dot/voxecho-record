import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { ROLES } from '@voxecho/shared';

class AttributsDto {
  @IsString() login!: string;
  @IsString() email!: string;
  @IsString() nomAffiche!: string;
  @IsString() groupes!: string;
}

class RegleDto {
  @IsString() groupeDn!: string;

  @IsIn(ROLES)
  role!: (typeof ROLES)[number];

  @IsString() tenantId!: string;
}

class SynchroDto {
  @IsBoolean() actif!: boolean;

  @IsInt()
  @Min(1)
  @Max(168)
  intervalleHeures!: number;
}

class ReglagesAnnuaireDto {
  @IsBoolean() actif!: boolean;

  @IsOptional() @IsString() url!: string | null;
  @IsBoolean() startTls!: boolean;
  @IsBoolean() verifierCertificat!: boolean;
  @IsOptional() @IsString() acPem!: string | null;
  @IsOptional() @IsString() baseDn!: string | null;
  @IsOptional() @IsString() bindDn!: string | null;
  @IsString() filtre!: string;

  @ValidateNested()
  @Type(() => AttributsDto)
  attributs!: AttributsDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RegleDto)
  regles!: RegleDto[];

  @ValidateNested()
  @Type(() => SynchroDto)
  synchro!: SynchroDto;
}

export class MajAnnuaireDto {
  @ValidateNested()
  @Type(() => ReglagesAnnuaireDto)
  reglages!: ReglagesAnnuaireDto;

  @IsInt()
  @Min(0)
  version!: number;

  /**
   * Présent uniquement pour remplacer le secret. Absent, l'ancien demeure :
   * un champ pré-rempli d'un masque finirait renvoyé tel quel (§9.36).
   */
  @IsOptional()
  @IsString()
  bindMotDePasse?: string;
}

export class TestAnnuaireDto {
  @IsOptional()
  @IsString()
  login?: string;
}
