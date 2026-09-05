import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Rattachement d'un compte local à l'annuaire — CLAUDE.md §9.37.
 *
 * Le drapeau assume une opération qui ne laisserait qu'un seul administrateur
 * local, comme la levée d'un hold sans contre-validation (§9.29) : le refus
 * vient d'abord, l'acceptation ensuite, et le fait est consigné.
 */
export class RattacherDto {
  @IsOptional()
  @IsBoolean()
  acceptSansContreValidation?: boolean;
}
