/**
 * Console d'administration — CLAUDE.md §9.22.
 *
 * Ce que l'administrateur de l'instance peut lire de son installation. Les
 * réglages qui commandent la valeur probante du journal — la confiance
 * accordée aux relais, le plancher de conservation — sont **exposés sans être
 * modifiables** : un compte compromis qui pourrait déclarer confiance à tout
 * le monde se rendrait invisible du journal d'audit (§9.16), et un plancher
 * abaissé depuis un écran ferait de la conservation une affaire de clic.
 *
 * Aucun secret n'y figure. La clé maître est désignée par son empreinte
 * publique (§9.14), jamais par sa valeur ; les secrets de jetons ne sont même
 * pas nommés.
 */

/** Un réglage d'instance, tel qu'il se lit dans la console. */
export interface ReglageInstance {
  cle: string;
  valeur: string;
  /** Ce que ce réglage commande, en une phrase lisible par un contrôleur. */
  effet: string;
  /** Pourquoi il ne se change pas ici, quand c'est le cas. */
  raisonLectureSeule?: string;
}

export interface InstanceSettingsResponse {
  /** Version du produit qui sert cette instance. */
  version: string;
  /** Vrai quand l'instance sert des données fabriquées (§9.21). */
  evaluation: boolean;
  /** Réglages groupés par domaine, dans l'ordre où on les lit. */
  groupes: { titre: string; reglages: ReglageInstance[] }[];
  /** Locataires servis par l'instance, et ce qu'ils pèsent. */
  locataires: {
    id: string;
    nom: string;
    slug: string;
    actif: boolean;
    comptes: number;
    enregistrements: number;
  }[];
}
