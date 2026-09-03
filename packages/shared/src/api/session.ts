import type { Role } from '../domain/enums.js';

export interface LoginRequest {
  email: string;
  password: string;
}

export interface TokenPairResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

/** Profil renvoyé par `/api/auth/me` — alimente le bandeau locataire. */
export interface ProfileResponse {
  id: string;
  email: string;
  role: Role;
  tenantId: string;
  tenantName: string;
  /**
   * Administrateur de l'instance — CLAUDE.md §9.22. Le portail s'en sert pour
   * masquer ce qui ne le concerne pas ; c'est l'api qui refuse, le masquage
   * n'étant qu'un confort d'affichage (§9.9).
   */
  instanceAdmin: boolean;
}
