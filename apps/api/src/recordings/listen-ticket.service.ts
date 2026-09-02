import { createHash } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfig } from '../config/config.module';

/** Ce que le billet autorise : un compte, un locataire, un enregistrement. */
export interface ListenTicket {
  userId: string;
  tenantId: string;
  recordingId: string;
}

interface ListenTicketPayload {
  sub: string;
  tid: string;
  rid: string;
}

/**
 * Billets d'écoute — CLAUDE.md §6.
 *
 * Un `<audio>` ne peut pas porter d'en-tête `Authorization` : le portail
 * obtient donc d'abord un billet, avec son jeton habituel, puis le lecteur le
 * présente à chaque requête `Range`.
 *
 * Le billet est signé avec un secret **dérivé** de `JWT_ACCESS_SECRET`, et
 * non avec lui : un billet ne peut donc pas servir de jeton d'accès, quand
 * bien même quelqu'un le présenterait en `Bearer`. La séparation est
 * structurelle, pas conventionnelle — elle ne dépend d'aucun champ qu'on
 * pourrait oublier de vérifier.
 */
@Injectable()
export class ListenTicketService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
  ) {}

  async issue(ticket: ListenTicket): Promise<{ ticket: string; expiresIn: string }> {
    const payload: ListenTicketPayload = {
      sub: ticket.userId,
      tid: ticket.tenantId,
      rid: ticket.recordingId,
    };
    const expiresIn = this.config.get('LISTEN_TICKET_TTL');
    return {
      ticket: await this.jwt.signAsync(payload, { secret: this.secret(), expiresIn }),
      expiresIn,
    };
  }

  /**
   * Vérifie un billet et l'enregistrement qu'il vise. Un billet valable pour
   * un autre appel ne donne rien : il ne se recycle pas d'un enregistrement
   * à l'autre.
   */
  async verify(brut: string, recordingId: string): Promise<ListenTicket> {
    let payload: ListenTicketPayload;
    try {
      payload = await this.jwt.verifyAsync<ListenTicketPayload>(brut, { secret: this.secret() });
    } catch {
      throw new UnauthorizedException('Billet d’écoute invalide ou expiré.');
    }
    if (payload.rid !== recordingId) {
      throw new UnauthorizedException('Billet d’écoute invalide ou expiré.');
    }
    return { userId: payload.sub, tenantId: payload.tid, recordingId: payload.rid };
  }

  private secret(): string {
    return createHash('sha256')
      .update(`${this.config.get('JWT_ACCESS_SECRET')}:ecoute`)
      .digest('hex');
  }
}
