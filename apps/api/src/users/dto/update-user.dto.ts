import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { ROLES, type Role } from '@voxecho/shared';

/** Ce qu'un administrateur peut changer d'un compte : son rôle, son activité. */
export class UpdateUserDto {
  @IsOptional()
  @IsIn(ROLES, { message: `rôle attendu : ${ROLES.join(', ')}` })
  role?: Role;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
