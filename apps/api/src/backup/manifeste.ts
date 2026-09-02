import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Manifeste de sauvegarde — CLAUDE.md §9.14.
 *
 * Une sauvegarde qui ne se décrit pas oblige, le jour de la restauration, à
 * deviner ce qu'elle contient et à quelle époque : c'est le pire moment pour
 * découvrir qu'il manque une pièce. Le manifeste dit ce qui a été pris, à
 * quelle date, de quelle instance, et surtout ce qu'il faut avoir **à côté**
 * pour que la restauration rende quelque chose — la clé maître au premier
 * chef, désignée par son empreinte et jamais par sa valeur.
 *
 * Le nom des fichiers y figure : une sauvegarde se relit avec le seul
 * manifeste sous les yeux, sans connaître la convention de nommage du produit
 * qui l'a écrite.
 */

export const MANIFESTE_SCHEMA = 1;
export const NOM_MANIFESTE = 'manifeste.json';
export const NOM_DUMP = 'base.dump';
export const NOM_INVENTAIRE = 'inventaire.jsonl';

const empreinteSha256 = z.string().regex(/^[0-9a-f]{64}$/, 'empreinte SHA-256 attendue');

export const manifesteSchema = z.object({
  schema: z.literal(MANIFESTE_SCHEMA),
  /** Horodatage de la prise, en UTC. */
  produitLe: z.string().datetime(),
  /** Version du produit qui a écrit la sauvegarde. */
  version: z.string(),

  base: z.object({
    fichier: z.string(),
    format: z.literal('pg_dump-custom'),
    /** Schéma PostgreSQL sauvegardé — l'api n'en utilise qu'un. */
    schemaPostgres: z.string(),
    octets: z.number().int().nonnegative(),
    sha256: empreinteSha256,
    /** Dernière migration Prisma appliquée : ce que la restauration attend. */
    derniereMigration: z.string().nullable(),
    migrationsAppliquees: z.number().int().nonnegative(),
  }),

  stockage: z.object({
    fichier: z.string(),
    sha256: empreinteSha256,
    /** Racine des chemins de l'inventaire, telle qu'elle était à la prise. */
    racine: z.string(),
    pieces: z.number().int().nonnegative(),
    /** Somme des tailles de clair — ce que pèsent les pièces conservées. */
    octetsClair: z.number().int().nonnegative(),
    scellees: z.number().int().nonnegative(),
    enClair: z.number().int().nonnegative(),
    /** Pièces dont le fichier a été détruit par une purge (§9.7). */
    purgees: z.number().int().nonnegative(),
    /** Références de clé rencontrées : autant de clés à détenir. */
    cles: z.array(z.string()),
  }),

  /**
   * La clé maître n'est **pas** dans la sauvegarde. Son empreinte y est, pour
   * que la restauration reconnaisse la bonne clé du premier coup.
   */
  cleMaitre: z.object({
    empreinte: z
      .string()
      .regex(/^[0-9a-f]{32}$/)
      .nullable(),
    /** Rappel destiné à qui relira la sauvegarde sans le mode d'emploi. */
    note: z.string(),
  }),

  locataires: z.array(
    z.object({
      id: z.string(),
      slug: z.string(),
      nom: z.string(),
      actif: z.boolean(),
      pieces: z.number().int().nonnegative(),
    }),
  ),
});

export type Manifeste = z.infer<typeof manifesteSchema>;

export const NOTE_CLE_MAITRE =
  'La clé maître n’est pas dans cette sauvegarde. Sans elle, les pièces scellées ' +
  'restent définitivement illisibles : la conserver ailleurs, et vérifier que son ' +
  'empreinte est bien celle inscrite ici (CLAUDE.md §9.14).';

/** Sérialisation stable : deux manifestes identiques ont la même empreinte. */
export function serialiserManifeste(manifeste: Manifeste): string {
  return `${JSON.stringify(manifeste, null, 2)}\n`;
}

export function empreinteDe(contenu: Buffer | string): string {
  return createHash('sha256').update(contenu).digest('hex');
}

/**
 * Relit un manifeste. Un manifeste illisible est un incident, pas un détail :
 * la sauvegarde qu'il décrit ne peut plus être vérifiée, donc plus être
 * tenue pour restaurable.
 */
export function lireManifeste(brut: string): Manifeste {
  const resultat = manifesteSchema.safeParse(JSON.parse(brut) as unknown);
  if (!resultat.success) {
    const details = resultat.error.issues
      .map((issue) => `  - ${issue.path.join('.')} : ${issue.message}`)
      .join('\n');
    throw new Error(`Manifeste de sauvegarde invalide :\n${details}`);
  }
  return resultat.data;
}
