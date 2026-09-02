/**
 * Ce qu'un contrôle a trouvé — CLAUDE.md §9.14, §9.15.
 *
 * Une liste d'anomalies plafonnée compte le nombre d'éléments qu'elle a
 * retenus, jamais le nombre qu'elle a rencontrés : un rapport annonçait
 * « 20 pièce(s) absente(s) » là où il en manquait cinq mille. Sur un produit
 * de preuve, sous-estimer un sinistre est pire que de ne rien dire — un
 * exploitant qui lit vingt lignes conclut à un incident local et referme.
 *
 * Un constat compte donc **tout** et n'énumère que les premières : le total
 * est exact, le détail suffit à commencer les recherches, et le rapport dit
 * lui-même que la liste a été coupée.
 */

/** Nombre d'exemples énumérés par constat, au-delà on ne fait plus que compter. */
export const MAX_EXEMPLES = 20;

export interface Constat {
  /** Nombre d'éléments rencontrés — jamais le nombre d'exemples retenus. */
  total: number;
  exemples: string[];
  /** Vrai si des éléments n'ont pas été énumérés. */
  tronque: boolean;
}

export function constatVide(): Constat {
  return { total: 0, exemples: [], tronque: false };
}

export function noter(constat: Constat, quoi: string): void {
  constat.total += 1;
  if (constat.exemples.length < MAX_EXEMPLES) constat.exemples.push(quoi);
  else constat.tronque = true;
}

/** Lignes à afficher pour un constat non vide, détail compris. */
export function lignesDe(constat: Constat, intitule: string): string[] {
  if (constat.total === 0) return [];
  const lignes = constat.exemples.map((exemple) => `    ! ${intitule} : ${exemple}`);
  if (constat.tronque) {
    lignes.push(`    … ${constat.total - constat.exemples.length} autre(s) non énuméré(s)`);
  }
  return lignes;
}
