import type { AuditAction } from '../domain/enums.js';

/**
 * Journal d'audit — CLAUDE.md §6 et §9.11.
 *
 * C'est la pièce que vient lire un contrôleur : elle doit répondre à « qui a
 * fait quoi, quand, sur quoi, et depuis où ». Le journal est append-only ; il
 * ne s'expose donc qu'en lecture, et aucune route ne le modifie.
 */

/** Une entrée, telle que le portail l'affiche. */
export interface AuditEventItem {
  id: string;
  at: string;
  action: AuditAction;
  /**
   * Adresse du compte à l'origine de l'acte. Nulle pour ce que fait le
   * produit lui-même — une ingestion n'a pas d'auteur humain.
   */
  actorEmail: string | null;
  /**
   * Nul pour un événement que l'instance ne rattache à aucun locataire : un
   * dépôt tombé dans un répertoire inconnu ou désactivé (§9.2). Réservé à
   * l'ADMIN de l'instance.
   */
  tenantId: string | null;
  recordingId: string | null;
  /** Référence PBX de l'appel concerné, pour ne pas lire des identifiants. */
  recordingRefci: string | null;
  ip: string | null;
  detail: Record<string, unknown> | null;
}

/**
 * Périmètre de lecture. Les événements système — ceux qu'aucun locataire ne
 * réclame — ne sont lisibles que par un ADMIN de l'instance.
 */
export const AUDIT_SCOPES = ['tenant', 'system', 'all'] as const;
export type AuditScope = (typeof AUDIT_SCOPES)[number];

export interface AuditFilters {
  action?: AuditAction;
  /** Fragment d'adresse e-mail de l'auteur. */
  actor?: string;
  recordingId?: string;
  /** Bornes en jour local de Douala, comme la recherche d'appels. */
  from?: string;
  to?: string;
  scope?: AuditScope;
}

export interface AuditListQuery extends AuditFilters {
  page?: number;
  pageSize?: number;
}

/** Nom du fichier proposé à l'export CSV du journal. */
export const AUDIT_CSV_FILENAME = 'journal-audit.csv';
