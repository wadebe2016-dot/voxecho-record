/**
 * Énumérations du domaine, partagées entre l'api et le portail.
 * Elles doivent rester alignées sur le schéma Prisma (CLAUDE.md §5).
 */

/** Rôles applicatifs. Appliqués côté api ET masqués côté UI. */
export const ROLES = ['ADMIN', 'SUPERVISOR', 'AUDITOR'] as const;
export type Role = (typeof ROLES)[number];

/** Cycle de vie d'un enregistrement. */
export const RECORDING_STATUSES = ['stored', 'archived', 'purged', 'hold'] as const;
export type RecordingStatus = (typeof RECORDING_STATUSES)[number];

/**
 * Actions tracées au journal d'audit. Le journal est append-only :
 * aucune route ne met à jour ni ne supprime un événement.
 */
export const AUDIT_ACTIONS = [
  'LOGIN',
  'SEARCH',
  'LISTEN',
  'EXPORT',
  'INGEST',
  'QUARANTINE',
  'PURGE',
  'HOLD_SET',
  'HOLD_RELEASE',
  'RETENTION_SET',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
