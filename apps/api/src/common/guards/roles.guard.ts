import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import type { Request } from 'express';
import { ADMIN_INSTANCE_KEY } from '../decorators/admin-instance.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';

/** Applique `@Roles(...)`. Sans annotation, tout compte authentifié passe. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<Request>().user;

    // Administration de l'instance : un privilège porté à part, jamais déduit
    // du rôle (§9.22). Vérifié avant les rôles — une route d'instance n'est
    // pas ouverte parce qu'on administre son propre locataire.
    const instanceRequise = this.reflector.getAllAndOverride<boolean>(ADMIN_INSTANCE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (instanceRequise === true && user?.instanceAdmin !== true) {
      throw new ForbiddenException('Réservé à l’administrateur de l’instance.');
    }

    const requis = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requis || requis.length === 0) return true;

    if (!user || !requis.includes(user.role)) {
      throw new ForbiddenException('Rôle insuffisant pour cette action.');
    }
    return true;
  }
}
