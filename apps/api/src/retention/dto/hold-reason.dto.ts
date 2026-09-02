import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Motif d'une pose ou d'une levée de conservation forcée. Un hold sans motif
 * lisible ne vaut rien devant un contrôleur : il faudrait retrouver qui l'a
 * posé et lui demander pourquoi.
 */
export class HoldReasonDto {
  @IsString()
  @MinLength(10, { message: 'motif : au moins dix caractères, pas une initiale' })
  @MaxLength(500)
  reason!: string;
}
