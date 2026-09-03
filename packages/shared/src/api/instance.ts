/**
 * Ce que le portail apprend de l'instance avant toute connexion —
 * CLAUDE.md §9.18, vocabulaire amendé au §9.21.
 *
 * Une version d'évaluation doit le dire. Un visiteur qui voit des appels, des
 * empreintes et un journal d'audit n'a aucun moyen de savoir s'il regarde des
 * conversations simulées ou celles des clients d'une banque : le laisser dans
 * le doute serait le pire des dark-patterns pour un produit dont la valeur est
 * la preuve (§6).
 *
 * La réponse est publique — elle ne dit rien qu'un visiteur ne puisse déduire —
 * et lue avant l'écran de connexion, qui l'affiche.
 */
export interface InstanceInfoResponse {
  /** Vrai quand l'instance sert des données fabriquées pour l'évaluation. */
  evaluation: boolean;
}
