import type { IngestMetadata } from './contract.js';

/**
 * Nommage des fichiers déposés — CLAUDE.md §3 :
 *
 *   20260901-143012_16778001_1001_699112233.wav
 *   20260901-143012_16778001_1001_699112233.json
 *
 * Radical = `<yyyymmdd>-<HHMMSS>_<refci>_<near>_<far>`, identique pour les deux
 * fichiers. Le nom est conservé au déplacement vers STORAGE_DIR.
 */

export const RADICAL_PATTERN =
  /^(\d{8})-(\d{6})_([A-Za-z0-9+.-]+)_([A-Za-z0-9+.-]+)_([A-Za-z0-9+.-]+)$/;

export interface ParsedRadical {
  /** Date locale du producteur, au format yyyymmdd. */
  readonly date: string;
  /** Heure locale du producteur, au format HHMMSS. */
  readonly time: string;
  readonly refci: string;
  readonly near: string;
  readonly far: string;
}

/** Découpe un radical. Renvoie `null` si le nom ne suit pas le contrat. */
export function parseRadical(radical: string): ParsedRadical | null {
  const match = RADICAL_PATTERN.exec(radical);
  if (!match) return null;
  const [, date, time, refci, near, far] = match;
  if (!date || !time || !refci || !near || !far) return null;
  return { date, time, refci, near, far };
}

/** Retire l'extension `.wav` ou `.json` d'un nom de fichier déposé. */
export function radicalOf(fileName: string): string {
  return fileName.replace(/\.(wav|json)$/i, '');
}

/** Reconstruit le radical attendu à partir des métadonnées validées. */
export function buildRadical(metadata: IngestMetadata): string {
  const started = new Date(metadata.startedAt);
  const offsetMatch = /([+-]\d{2}):(\d{2})$/.exec(metadata.startedAt);
  const offsetMinutes = offsetMatch
    ? Number(`${offsetMatch[1]}`) * 60 + Math.sign(Number(offsetMatch[1])) * Number(offsetMatch[2])
    : 0;
  const local = new Date(started.getTime() + offsetMinutes * 60_000);
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0');
  const date = `${local.getUTCFullYear()}${pad(local.getUTCMonth() + 1)}${pad(local.getUTCDate())}`;
  const time = `${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}${pad(local.getUTCSeconds())}`;
  return `${date}-${time}_${metadata.refci}_${metadata.near}_${metadata.far}`;
}
