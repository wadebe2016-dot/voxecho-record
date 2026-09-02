import { SetMetadata } from '@nestjs/common';
import type { Role } from '@prisma/client';

export const ROLES_KEY = 'voxecho:roles';

/** Restreint une route à certains rôles. Les rôles sont appliqués ici, côté
 * api ; le masquage côté portail n'est qu'un confort d'affichage. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
