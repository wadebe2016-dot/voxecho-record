import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Cloisonnement multi-locataire : le locataire ne se lit **que** dans le
 * jeton. Toute requête qui tente d'en désigner un autre (paramètre, requête
 * ou corps `tenantId`) est refusée plutôt qu'ignorée — un client qui essaie
 * de changer de locataire doit être vu, pas silencieusement corrigé.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;
    if (!user) return true; // route publique : rien à cloisonner

    for (const source of [request.params, request.query, request.body]) {
      const revendique = (source as Record<string, unknown> | undefined)?.['tenantId'];
      if (typeof revendique === 'string' && revendique !== user.tenantId) {
        throw new ForbiddenException('Accès à un autre locataire refusé.');
      }
    }
    return true;
  }
}
