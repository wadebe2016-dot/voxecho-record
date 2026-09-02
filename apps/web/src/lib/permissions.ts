import type { Role } from '@voxecho/shared';

/**
 * Ce que chaque rôle peut voir dans le portail. Le masquage n'est qu'un
 * confort d'affichage : l'autorisation qui fait foi est appliquée par l'api.
 */
export const CAPACITES = {
  consulterEnregistrements: ['ADMIN', 'SUPERVISOR', 'AUDITOR'],
  /**
   * Entendre une conversation de client, ou en emporter une copie, n'est pas
   * un droit d'exploitation (CLAUDE.md §9.9). Le SUPERVISOR consulte les
   * appels et leurs métadonnées ; il ne les écoute pas et ne les exporte pas.
   * L'export partage cette habilitation : une archive contient l'audio.
   */
  ecouterEnregistrements: ['ADMIN', 'AUDITOR'],
  consulterJournalAudit: ['ADMIN', 'AUDITOR'],
  gererComptes: ['ADMIN'],
  gererRetention: ['ADMIN'],
} as const satisfies Record<string, readonly Role[]>;

export type Capacite = keyof typeof CAPACITES;

export function peut(role: Role | undefined, capacite: Capacite): boolean {
  if (!role) return false;
  return (CAPACITES[capacite] as readonly Role[]).includes(role);
}
