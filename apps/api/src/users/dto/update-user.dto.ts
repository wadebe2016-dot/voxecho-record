import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { ROLES, type Role } from '@voxecho/shared';

/** Ce qu'un administrateur peut changer d'un compte : son rôle, son activité. */
export class UpdateUserDto {
  /**
   * Assume une opération qui ne laisserait qu'un seul administrateur local
   * (§9.37). Le fait est consigné, comme la levée d'un hold sans
   * contre-validation (§9.29).
   */
  @IsOptional()
  @IsBoolean()
  acceptSansContreValidation?: boolean;

  @IsOptional()
  @IsIn(ROLES, { message: `rôle attendu : ${ROLES.join(', ')}` })
  role?: Role;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
