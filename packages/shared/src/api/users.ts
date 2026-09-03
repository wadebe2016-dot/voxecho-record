import type { Role } from '../domain/enums.js';

/**
 * Gestion des comptes — CLAUDE.md §9.26.
 *
 * Un compte ne se supprime pas : il se désactive. Le journal d'audit référence
 * son auteur, et effacer un compte effacerait le lien vers ce qu'il a écouté
 * (§5, `onDelete: Restrict`).
 */

export interface UserSummary {
  id: string;
  email: string;
  role: Role;
  active: boolean;
  /** Administrateur de l'instance, et non du seul locataire (§9.22). */
  instanceAdmin: boolean;
  /** Mot de passe provisoire non encore renouvelé. */
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  /** Verrouillé jusqu'à cette date après des échecs de connexion. */
  lockedUntil: string | null;
  createdAt: string;
}

export interface CreateUserRequest {
  email: string;
  role: Role;
}

export interface UpdateUserRequest {
  role?: Role;
  active?: boolean;
}

/**
 * Un mot de passe provisoire, rendu **une seule fois** : il n'est stocké nulle
 * part en clair, et l'écran qui l'affiche est le seul endroit où il paraîtra.
 */
export interface TemporaryPasswordResponse {
  compte: UserSummary;
  motDePasseProvisoire: string;
}
