import type { Role } from '@voxecho/shared';

/**
 * Ce que chaque rôle peut voir dans le portail. Le masquage n'est qu'un
 * confort d'affichage : l'autorisation qui fait foi est appliquée par l'api.
 */
export const CAPACITES = {
  consulterEnregistrements: ['ADMIN', 'SUPERVISOR', 'AUDITOR'],
  consulterJournalAudit: ['ADMIN', 'AUDITOR'],
  gererComptes: ['ADMIN'],
  gererRetention: ['ADMIN'],
} as const satisfies Record<string, readonly Role[]>;

export type Capacite = keyof typeof CAPACITES;

export function peut(role: Role | undefined, capacite: Capacite): boolean {
  if (!role) return false;
  return (CAPACITES[capacite] as readonly Role[]).includes(role);
}
