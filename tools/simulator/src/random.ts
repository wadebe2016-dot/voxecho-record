/**
 * Générateur pseudo-aléatoire déterministe (mulberry32).
 *
 * Une démonstration doit pouvoir être rejouée : à graine égale, le simulateur
 * dépose exactement les mêmes appels. C'est aussi ce qui rend les tests
 * lisibles — on assied les vérifications sur des valeurs reproductibles
 * plutôt que sur des moyennes.
 */
export interface Alea {
  /** Réel dans [0, 1[. */
  next(): number;
  /** Entier dans [min, max]. */
  entier(min: number, max: number): number;
  /** Un élément au hasard. */
  parmi<T>(valeurs: readonly T[]): T;
  /** Vrai avec la probabilité donnée. */
  chance(probabilite: number): boolean;
}

export function creerAlea(graine: number): Alea {
  let etat = graine >>> 0;

  const next = (): number => {
    etat = (etat + 0x6d2b79f5) >>> 0;
    let t = etat;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  const entier = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));

  return {
    next,
    entier,
    parmi: <T>(valeurs: readonly T[]): T => valeurs[entier(0, valeurs.length - 1)] as T,
    chance: (probabilite: number): boolean => next() < probabilite,
  };
}
