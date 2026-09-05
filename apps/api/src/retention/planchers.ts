import { INGEST_OPERATION_CATEGORIES } from '@voxecho/shared';

/**
 * Planchers réglementaires par catégorie d'opération — CLAUDE.md §9.30.
 *
 * Deux planchers coexistent, et ils ne disent pas la même chose. Celui de
 * l'instance (`RETENTION_MIN_DAYS`) est une **règle de maison** : on peut
 * descendre en dessous avec un motif écrit, et le journal en garde trace
 * (§9.6). Celui-ci se veut l'écho d'une **obligation extérieure** : on ne
 * déroge pas à un texte par une phrase dans un formulaire.
 *
 * Il vaut zéro par défaut, et c'est délibéré : tant que la cote de texte n'est
 * pas établie (§9.9), le produit ne fait pas semblant de connaître une durée
 * légale. C'est l'exploitant qui la déclare, en connaissance de cause.
 */

export type PlanchersReglementaires = Readonly<Record<string, number>>;

export function lirePlanchersReglementaires(brut: string): PlanchersReglementaires {
  const planchers: Record<string, number> = {};

  for (const morceau of brut.split(',')) {
    const declaration = morceau.trim();
    if (declaration === '') continue;

    const [categorie, jours] = declaration.split(':').map((part) => part.trim());
    if (categorie === undefined || jours === undefined) {
      throw new Error(
        `RETENTION_REGULATORY_FLOORS : « ${declaration} » — format attendu « categorie:jours ».`,
      );
    }
    if (!(INGEST_OPERATION_CATEGORIES as readonly string[]).includes(categorie)) {
      // Même règle qu'au §9.10 : une catégorie que personne n'a déclarée est
      // une faute de frappe, et un plancher posé sur elle ne protégerait rien.
      throw new Error(
        `RETENTION_REGULATORY_FLOORS : catégorie inconnue « ${categorie} » ` +
          `(${INGEST_OPERATION_CATEGORIES.join(', ')}).`,
      );
    }
    const valeur = Number(jours);
    if (!Number.isInteger(valeur) || valeur < 0 || valeur > 36_500) {
      throw new Error(
        `RETENTION_REGULATORY_FLOORS : « ${jours} » — un nombre de jours entre 0 et 36500 est attendu.`,
      );
    }
    planchers[categorie] = valeur;
  }

  return planchers;
}

/** Le plancher applicable à une catégorie. Zéro quand rien n'est déclaré. */
export function plancherDe(planchers: PlanchersReglementaires, categorie: string | null): number {
  if (categorie === null) return 0;
  return planchers[categorie] ?? 0;
}
