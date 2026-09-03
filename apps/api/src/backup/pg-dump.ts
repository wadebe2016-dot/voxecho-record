import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const executer = promisify(execFile);

/**
 * Appel de `pg_dump` — CLAUDE.md §9.14.
 *
 * Le format `custom` plutôt qu'un script SQL : il se restaure sélectivement
 * (`pg_restore`), il est compressé, et il refuse d'être restauré à moitié en
 * silence. Une sauvegarde de conformité n'a pas à être lisible dans un
 * éditeur de texte ; elle a à revenir entière.
 *
 * `--no-owner` et `--no-privileges` : une restauration se fait souvent sous
 * un autre compte que celui d'origine (bac à sable, machine de secours), et
 * un dump qui exige un rôle absent échoue au pire moment.
 */

export interface CibleBase {
  /** URL de connexion, débarrassée du paramètre `schema` de Prisma. */
  url: string;
  /** Schéma à sauvegarder — celui que l'URL Prisma désignait. */
  schema: string;
}

/** Ce que la sauvegarde attend d'un producteur de dump ; injectable en test. */
export type Dumper = (cible: CibleBase, destination: string) => Promise<void>;

/**
 * Sépare l'URL de connexion du schéma. `pg_dump` parle à libpq, qui refuse
 * l'URL de Prisma telle quelle : `schema` n'est pas un paramètre de connexion
 * PostgreSQL, et une URL qui en porte un est rejetée d'emblée.
 */
export function cibleDepuisUrl(brut: string): CibleBase {
  const url = new URL(brut);
  const schema = url.searchParams.get('schema') ?? 'public';
  url.searchParams.delete('schema');
  // `connection_limit` et consorts sont propres à Prisma : libpq les refuse
  // au même titre.
  // `options` porte le fuseau que l'api impose à sa session (§9.27) : il n'a
  // pas de sens ici, nos colonnes d'horodatage étant sans fuseau.
  for (const parametre of ['connection_limit', 'pool_timeout', 'pgbouncer', 'options']) {
    url.searchParams.delete(parametre);
  }
  return { url: url.toString(), schema };
}

export const pgDump: Dumper = async (cible, destination) => {
  try {
    await executer(
      'pg_dump',
      [
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        `--schema=${cible.schema}`,
        `--file=${destination}`,
        cible.url,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
  } catch (erreur) {
    const code = (erreur as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Le manque est d'exploitation, pas de code : on dit quoi installer
      // plutôt que de laisser lire une trace d'exécution.
      throw new Error(
        'pg_dump est introuvable : installer le client PostgreSQL 16 ' +
          '(paquet postgresql-client-16) sur la machine qui sauvegarde. ' +
          'L’image docker de l’api l’embarque déjà.',
      );
    }
    const stderr = (erreur as { stderr?: string }).stderr ?? '';
    throw new Error(`pg_dump a échoué : ${stderr.trim() || String(erreur)}`);
  }
};

/** Signature d'une archive `pg_dump` au format custom. */
export const SIGNATURE_DUMP = Buffer.from('PGDMP', 'ascii');
