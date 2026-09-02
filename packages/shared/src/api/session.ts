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
}
