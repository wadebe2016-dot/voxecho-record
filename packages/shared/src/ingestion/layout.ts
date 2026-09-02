import { parseRadical } from './filename.js';

/**
 * Disposition des répertoires du contrat d'ingestion — CLAUDE.md §3.
 *
 * Le json ne porte pas le locataire : c'est l'arborescence qui le désigne.
 * Le producteur dépose la paire wav+json dans le sous-répertoire du locataire
 * qu'il alimente :
 *
 *   INGEST_DIR/<slug>/20260901-143012_16778001_1001_699112233.wav
 *   INGEST_DIR/<slug>/20260901-143012_16778001_1001_699112233.json
 *
 * Une fois la paire vérifiée, l'audio est déplacé sous
 * `STORAGE_DIR/<tenantId>/<yyyy>/<mm>/`, nom conservé. Le stockage est indexé
 * par identifiant et non par slug : un slug se renomme, une preuve déjà
 * rangée ne se déplace pas.
 */

/**
 * Slug de locataire : minuscules, chiffres et tirets. C'est un nom de
 * répertoire écrit par la capture, donc volontairement pauvre — ni accent,
 * ni espace, ni point, et jamais `.` ou `..` qui permettraient de sortir de
 * INGEST_DIR.
 */
export const TENANT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isTenantSlug(value: string): boolean {
  return TENANT_SLUG_PATTERN.test(value);
}

/** Fréquence d'échantillonnage attendue des WAV déposés (contrat §3). */
export const INGEST_SAMPLE_RATE = 8_000;

/**
 * Écart toléré entre la durée annoncée dans le json et celle calculée depuis
 * l'audio. `durationSec` est un entier de seconde : une seconde d'écart est
 * un arrondi, pas une anomalie. Au-delà, le wav ne correspond pas à ses
 * métadonnées (tronqué, par exemple) et la paire part en quarantaine.
 */
export const INGEST_DURATION_TOLERANCE_SEC = 2;

/** Extensions de la paire déposée, dans l'ordre d'arrivée : wav puis json. */
export const INGEST_AUDIO_EXTENSION = '.wav';
export const INGEST_METADATA_EXTENSION = '.json';

/**
 * Chemin de rangement relatif à STORAGE_DIR, dérivé du radical : la date du
 * radical est l'heure locale du producteur, donc celle que lit un contrôleur
 * dans le nom du fichier. Ranger selon elle évite qu'un appel du 1er à 00h30
 * se retrouve classé dans le mois précédent au gré d'un fuseau.
 *
 * Renvoie `null` si le radical ne suit pas le contrat.
 */
export function storageRelativePath(tenantId: string, radical: string): string | null {
  const parsed = parseRadical(radical);
  if (!parsed) return null;
  const year = parsed.date.slice(0, 4);
  const month = parsed.date.slice(4, 6);
  return `${tenantId}/${year}/${month}/${radical}${INGEST_AUDIO_EXTENSION}`;
}
