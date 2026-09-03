import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Barre l'accès tant qu'un mot de passe provisoire n'a pas été renouvelé —
 * CLAUDE.md §9.26.
 *
 * Un compte créé par un administrateur porte un mot de passe que cet
 * administrateur a lu. Tant qu'il n'a pas été changé, la session ne doit servir
 * qu'à cela : masquer le portail ne suffirait pas, puisque l'api reste
 * joignable directement.
 */
@Injectable()
export class MotDePasseGuard implements CanActivate {
  /** Les seules routes utiles à qui doit d'abord renouveler son mot de passe. */
  private readonly permises = new Set([
    'GET /api/auth/me',
    'POST /api/auth/password',
    'POST /api/auth/logout',
  ]);

  canActivate(contexte: ExecutionContext): boolean {
    const requete = contexte.switchToHttp().getRequest<Request>();
    if (requete.user?.mustChangePassword !== true) return true;

    // `route.path` porte le motif déclaré, insensible aux identifiants.
    const chemin = `${requete.method} ${requete.baseUrl}${requete.route?.path ?? requete.path}`;
    if (this.permises.has(chemin)) return true;

    throw new ForbiddenException(
      'Mot de passe provisoire : le renouveler avant d’accéder au reste du portail.',
    );
  }
}
