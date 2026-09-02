import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@prisma/client';
import type { Request } from 'express';
import { ROLES_KEY } from '../decorators/roles.decorator';

/** Applique `@Roles(...)`. Sans annotation, tout compte authentifié passe. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requis = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requis || requis.length === 0) return true;

    const user = context.switchToHttp().getRequest<Request>().user;
    if (!user || !requis.includes(user.role)) {
      throw new ForbiddenException('Rôle insuffisant pour cette action.');
    }
    return true;
  }
}
