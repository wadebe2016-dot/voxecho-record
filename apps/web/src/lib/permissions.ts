import type { Role } from '@voxecho/shared';

/**
 * Ce que chaque rôle peut voir dans le portail. Le masquage n'est qu'un
 * confort d'affichage : l'autorisation qui fait foi est appliquée par l'api.
 */
export const CAPACITES = {
  /** Chiffres d'exploitation : rien n'y dit qui a écouté quoi (§9.12). */
  consulterTableauDeBord: ['ADMIN', 'SUPERVISOR', 'AUDITOR'],
  consulterEnregistrements: ['ADMIN', 'SUPERVISOR', 'AUDITOR'],
  /**
   * Entendre une conversation de client, ou en emporter une copie, n'est pas
   * un droit d'exploitation (CLAUDE.md §9.9). Le SUPERVISOR consulte les
   * appels et leurs métadonnées ; il ne les écoute pas et ne les exporte pas.
   * L'export partage cette habilitation : une archive contient l'audio.
   */
  ecouterEnregistrements: ['ADMIN', 'AUDITOR'],
  consulterJournalAudit: ['ADMIN', 'AUDITOR'],
  /**
   * « Quelle politique s'appliquait ce jour-là ? » est une question de
   * conformité : les trois rôles la lisent (§9.23). Seul l'ADMIN la change.
   */
  consulterPolitiques: ['ADMIN', 'SUPERVISOR', 'AUDITOR'],
  gererPolitiques: ['ADMIN'],
  gererComptes: ['ADMIN'],
  gererRetention: ['ADMIN'],
  /**
   * Console d'administration. Le rôle ne suffit pas : l'entrée est en outre
   * réservée à qui administre l'instance (§9.22), ce que le profil dit et que
   * l'api vérifie de toute façon.
   */
  administrerInstance: ['ADMIN'],
} as const satisfies Record<string, readonly Role[]>;

export type Capacite = keyof typeof CAPACITES;

export function peut(role: Role | undefined, capacite: Capacite): boolean {
  if (!role) return false;
  return (CAPACITES[capacite] as readonly Role[]).includes(role);
}
