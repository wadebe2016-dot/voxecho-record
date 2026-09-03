import type { Role } from '@prisma/client';

/** Identité portée par le jeton d'accès et attachée à chaque requête. */
export interface AuthUser {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly role: Role;
  /**
   * Administrateur de l'instance — CLAUDE.md §9.22. Porté par le jeton comme
   * le rôle : la révocation prend donc effet à l'expiration de l'accès, au
   * même titre que la désactivation d'un compte aujourd'hui.
   */
  readonly instanceAdmin: boolean;
  /**
   * Mot de passe provisoire à renouveler (§9.26). Tant qu'il est vrai, l'api
   * ne laisse passer que le profil, le changement de mot de passe et la
   * déconnexion.
   */
  readonly mustChangePassword: boolean;
}

/** Charge utile du jeton d'accès. */
export interface AccessTokenPayload {
  sub: string;
  tid: string;
  email: string;
  role: Role;
  /** Administrateur de l'instance (§9.22). Absent des jetons antérieurs. */
  adm?: boolean;
  /** Mot de passe provisoire à renouveler (§9.26). */
  chg?: boolean;
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
