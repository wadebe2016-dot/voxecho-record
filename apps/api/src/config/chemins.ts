import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Résolution des répertoires de données (`INGEST_DIR`, `STORAGE_DIR`,
 * `QUARANTINE_DIR`).
 *
 * Ces chemins étaient résolus depuis le répertoire courant. En livraison ils
 * sont absolus (`/data/...`) et rien ne paraissait ; en développement, la
 * procédure du README — `pnpm dev` — lance l'api avec `apps/api` pour
 * répertoire courant, si bien que `./data/storage` désignait
 * `apps/api/data/storage` : toute réécoute rendait 404 « fichier absent du
 * stockage », et l'ingestion surveillait un répertoire vide qu'elle venait de
 * créer elle-même.
 *
 * Un chemin de conservation ne doit pas dépendre de l'endroit d'où l'on a
 * lancé le processus. Un chemin relatif est donc ancré à la racine du dépôt,
 * repérée par `pnpm-workspace.yaml` — le même repère que celui qui définit le
 * monorepo. Un chemin absolu, lui, n'est jamais réinterprété.
 */

/** Le fichier qui marque la racine du monorepo (CLAUDE.md §2). */
const MARQUEUR_RACINE = 'pnpm-workspace.yaml';

/**
 * Remonte jusqu'à la racine du dépôt. Faute de la trouver — image docker, où
 * le monorepo n'est pas copié et où les chemins sont de toute façon absolus —
 * on s'en tient au point de départ.
 */
export function racineDuDepot(depart: string = process.cwd()): string {
  let courant = resolve(depart);
  for (;;) {
    if (existsSync(join(courant, MARQUEUR_RACINE))) return courant;
    const parent = dirname(courant);
    if (parent === courant) return resolve(depart);
    courant = parent;
  }
}

/**
 * Chemin d'un répertoire de données, absolu et stable quel que soit le
 * répertoire courant du processus.
 */
export function resoudreCheminDeDonnees(chemin: string, depart?: string): string {
  return isAbsolute(chemin) ? resolve(chemin) : resolve(racineDuDepot(depart), chemin);
}
