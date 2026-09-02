import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  /** Normalisée avant validation : la casse et les espaces d'une saisie
   * manuelle ne doivent pas faire échouer une connexion légitime. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail({}, { message: 'Adresse électronique invalide.' })
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(8, { message: 'Mot de passe trop court.' })
  @MaxLength(200)
  password!: string;
}
