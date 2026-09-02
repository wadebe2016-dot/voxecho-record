import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Exécution d'un rapport de purge. Le motif n'est pas une formalité : c'est
 * le seul acte irréversible du produit, et le journal doit pouvoir dire au
 * nom de quoi des pièces probantes ont été détruites.
 */
export class ExecutePurgeDto {
  @IsString()
  @MinLength(10, { message: 'motif : au moins dix caractères, pas une initiale' })
  @MaxLength(500)
  reason!: string;
}
