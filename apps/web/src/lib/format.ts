/**
 * Mises en forme du portail. Fuseau Africa/Douala : un contrôleur lit des
 * heures locales, pas de l'UTC.
 */
const FUSEAU = 'Africa/Douala';

const HORODATAGE = new Intl.DateTimeFormat('fr-FR', {
  timeZone: FUSEAU,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** `01/09/2026 14:30:12` */
export function formatHorodatage(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return HORODATAGE.format(date).replace(', ', ' ');
}

/** Durée compacte et alignable : `3:03`, `1:02:45`. */
export function formatDuree(secondes: number): string {
  if (!Number.isFinite(secondes) || secondes < 0) return '—';
  const total = Math.floor(secondes);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const deux = (valeur: number) => String(valeur).padStart(2, '0');
  return h > 0 ? `${h}:${deux(m)}:${deux(s)}` : `${m}:${deux(s)}`;
}

/** Taille lisible, en unités binaires. */
export function formatTaille(octets: number): string {
  if (!Number.isFinite(octets) || octets < 0) return '—';
  const unites = ['o', 'Kio', 'Mio', 'Gio'];
  let valeur = octets;
  let index = 0;
  while (valeur >= 1024 && index < unites.length - 1) {
    valeur /= 1024;
    index += 1;
  }
  const decimales = index === 0 ? 0 : 1;
  return `${valeur.toFixed(decimales).replace('.', ',')} ${unites[index]}`;
}

const DIRECTIONS: Record<string, string> = {
  outbound: 'Sortant',
  inbound: 'Entrant',
  internal: 'Interne',
};

export function libelleDirection(direction: string): string {
  return DIRECTIONS[direction] ?? direction;
}

const STATUTS: Record<string, string> = {
  stored: 'Conservé',
  archived: 'Archivé',
  purged: 'Purgé',
  hold: 'Sous conservation',
};

export function libelleStatut(statut: string): string {
  return STATUTS[statut] ?? statut;
}

const ROLES: Record<string, string> = {
  ADMIN: 'Administrateur',
  SUPERVISOR: 'Superviseur',
  AUDITOR: 'Auditeur',
};

/** Catégories d'opération bancaire — CLAUDE.md §9.10. */
const CATEGORIES: Record<string, string> = {
  confirmation_cheque: 'Confirmation de chèque',
  operation_change: 'Opération de change',
  autre: 'Autre',
};

export function libelleCategorie(categorie: string): string {
  return CATEGORIES[categorie] ?? categorie;
}

/** Actions du journal d'audit, en clair — CLAUDE.md §6. */
const ACTIONS: Record<string, string> = {
  LOGIN: 'Connexion',
  SEARCH: 'Recherche',
  LISTEN: 'Écoute',
  EXPORT: 'Export',
  INGEST: 'Ingestion',
  QUARANTINE: 'Quarantaine',
  PURGE: 'Purge',
  PURGE_SIMULATED: 'Rapport de purge établi',
  PURGE_EXECUTED: 'Purge exécutée',
  PURGE_CANCELLED: 'Rapport de purge annulé',
  HOLD_SET: 'Conservation posée',
  HOLD_RELEASE: 'Conservation levée',
  RETENTION_SET: 'Rétention modifiée',
  POLICY_SET: 'Politique d’enregistrement publiée',
  USER_SET: 'Compte modifié',
};

export function libelleAction(action: string): string {
  return ACTIONS[action] ?? action;
}

export function libelleRole(role: string): string {
  return ROLES[role] ?? role;
}

/** Empreinte abrégée pour un tableau dense ; la valeur entière reste en titre. */
export function abregerEmpreinte(sha256: string): string {
  return sha256.length <= 16 ? sha256 : `${sha256.slice(0, 8)}…${sha256.slice(-8)}`;
}
