import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { TokensService } from '../../auth/tokens.service';
import { PUBLIC_KEY } from '../decorators/public.decorator';

/**
 * Garde global : toute route est authentifiée sauf marquage explicite
 * `@Public()`. L'oubli d'un garde ne peut donc pas ouvrir une route.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const estPublique = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (estPublique) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const entete = request.headers.authorization;
    if (!entete?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentification requise.');
    }

    request.user = await this.tokens.verifyAccess(entete.slice('Bearer '.length).trim());
    return true;
  }
}
