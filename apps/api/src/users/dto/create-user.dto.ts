import { IsEmail, IsIn, MaxLength } from 'class-validator';
import { ROLES, type Role } from '@voxecho/shared';

export class CreateUserDto {
  @IsEmail({}, { message: 'adresse électronique attendue' })
  @MaxLength(200)
  email!: string;

  @IsIn(ROLES, { message: `rôle attendu : ${ROLES.join(', ')}` })
  role!: Role;
}
