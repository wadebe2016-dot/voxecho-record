import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Changement de mot de passe par son titulaire. La longueur exacte est
 * vérifiée par la politique du §9.26, qui connaît le réglage de l'instance ;
 * ici on écarte seulement l'absurde.
 */
export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  ancien!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(200)
  nouveau!: string;
}
