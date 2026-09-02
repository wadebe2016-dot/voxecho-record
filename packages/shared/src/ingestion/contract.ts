import { z } from 'zod';

/**
 * Contrat d'ingestion — CLAUDE.md §3. Frontière sacrée entre la capture
 * (FreeSWITCH, hors dépôt) et le portail : rien du portail n'importe quoi que
 * ce soit de la capture, les deux ne communiquent que par ce contrat.
 *
 * Pour chaque appel terminé, le producteur dépose dans INGEST_DIR deux
 * fichiers de même radical : `<radical>.wav` puis `<radical>.json`.
 */

/** Version du schéma de métadonnées reconnue par cette version du portail. */
export const INGEST_SCHEMA_VERSION = 1;

export const INGEST_DIRECTIONS = ['outbound', 'inbound', 'internal'] as const;
export type IngestDirection = (typeof INGEST_DIRECTIONS)[number];

export const INGEST_SOURCES = ['cucm-bib', 'siprec', 'simulator'] as const;
export type IngestSource = (typeof INGEST_SOURCES)[number];

/** Identifiant téléphonique : chiffres, lettres et séparateurs usuels. */
const phoneLike = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9+.-]+$/, 'caractères non autorisés');

/**
 * Horodatage ISO 8601 **avec décalage explicite** (ex. 2026-09-01T14:30:12+01:00).
 * Un horodatage sans fuseau n'est pas probant : il est refusé.
 */
const isoWithOffset = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
    'horodatage ISO 8601 avec fuseau attendu',
  )
  .refine((value) => !Number.isNaN(Date.parse(value)), 'horodatage invalide');

/** Métadonnées déposées par le producteur, telles qu'elles sont lues du json. */
export const ingestMetadataSchema = z.object({
  schema: z.literal(INGEST_SCHEMA_VERSION),
  refci: phoneLike.describe("identifiant d'appel côté PBX"),
  near: phoneLike.describe('poste enregistré'),
  far: phoneLike.describe('correspondant'),
  direction: z.enum(INGEST_DIRECTIONS),
  startedAt: isoWithOffset,
  durationSec: z.number().int().nonnegative().max(86_400),
  source: z.enum(INGEST_SOURCES),
});

export type IngestMetadata = z.infer<typeof ingestMetadataSchema>;

/** Résultat de validation, sans exception : l'ingestion met en quarantaine. */
export type IngestMetadataResult =
  { ok: true; value: IngestMetadata } | { ok: false; errors: string[] };

/**
 * Valide des métadonnées brutes (json déjà parsé). Ne lève jamais : un json
 * invalide part en quarantaine avec la liste des motifs, jamais de suppression
 * silencieuse.
 */
export function parseIngestMetadata(input: unknown): IngestMetadataResult {
  const result = ingestMetadataSchema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return { ok: false, errors };
}
