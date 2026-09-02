import type { Role } from '@prisma/client';

/** Identité portée par le jeton d'accès et attachée à chaque requête. */
export interface AuthUser {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly role: Role;
}

/** Charge utile du jeton d'accès. */
export interface AccessTokenPayload {
  sub: string;
  tid: string;
  email: string;
  role: Role;
}

/** Charge utile du jeton de rafraîchissement. */
export interface RefreshTokenPayload {
  sub: string;
  tid: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

declare module 'express' {
  interface Request {
    user?: AuthUser;
  }
}
