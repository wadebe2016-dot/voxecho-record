import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { LimitationConnexion } from './limitation-connexion.service';

/**
 * Refuse les connexions d'une adresse qui vient d'enchaîner les échecs —
 * CLAUDE.md §9.16.
 *
 * Posé sur les seules routes d'authentification, jamais globalement : la
 * réécoute d'un appel de dix minutes provoque des dizaines de requêtes
 * `Range` (§9.4), et une limitation générale la casserait au premier
 * déplacement dans la conversation.
 */
@Injectable()
export class LimitationConnexionGuard implements CanActivate {
  constructor(
    private readonly limitation: LimitationConnexion,
    private readonly audit: AuditService,
  ) {}

  async canActivate(contexte: ExecutionContext): Promise<boolean> {
    const requete = contexte.switchToHttp().getRequest<Request>();
    const ip = requete.ip ?? requete.socket.remoteAddress ?? null;
    if (ip === null) return true;

    const verdict = this.limitation.verifier(ip);
    if (verdict.autorise) return true;

    if (verdict.premierRefus) {
      // Sans locataire ni compte : on ne sait pas qui frappe, et c'est
      // précisément ce qu'il faut consigner. Le précédent est au §9.2, où
      // les dépôts qu'aucun locataire ne réclame sont réservés à l'ADMIN de
      // l'instance. Aucune action nouvelle n'est ajoutée au §5.
      await this.audit.record({
        tenantId: null,
        userId: null,
        action: 'LOGIN',
        ip,
        detail: { resultat: 'bloque_par_limitation', attenteSec: verdict.attenteSec },
      });
    }

    // L'en-tête que lira un client correct, plutôt que de marteler.
    contexte
      .switchToHttp()
      .getResponse<Response>()
      .setHeader('Retry-After', String(verdict.attenteSec));

    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'Trop de tentatives de connexion. Réessayer dans un instant.',
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
