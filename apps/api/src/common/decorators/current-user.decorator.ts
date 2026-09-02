import { createParamDecorator, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../../auth/auth.types';

/** Injecte l'identité authentifiée. Absente = la route n'aurait pas dû passer. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<Request>();
  if (!request.user) {
    throw new UnauthorizedException('Authentification requise.');
  }
  return request.user satisfies AuthUser;
});
