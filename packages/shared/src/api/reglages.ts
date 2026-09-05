/**
 * Réglages d'instance — CLAUDE.md §9.36.
 *
 * Ils commandent ce que l'installation fait, non ce qu'une banque décide : ils
 * vivent donc au niveau de l'instance, et leur lecture comme leur écriture sont
 * réservées à l'administrateur de l'instance (§9.22).
 *
 * Chaque section est versionnée. L'écriture porte la version lue, et l'api la
 * refuse si elle a bougé : deux administrateurs qui modifient la même section
 * s'écraseraient sans cela.
 */

/** Mode de déploiement : ce qui décide des sections visibles (§9.36). */
export const MODES_DEPLOIEMENT = ['cloud', 'onprem'] as const;
export type ModeDeploiement = (typeof MODES_DEPLOIEMENT)[number];

/**
 * Ce qu'on peut dire d'une horloge.
 *
 * `indisponible` n'est pas `non_synchronise` : le premier dit qu'on n'a pas su
 * lire l'horloge, le second qu'on l'a lue et qu'elle ne suit plus. Seul le
 * second met en cause la valeur probante des horodatages.
 */
export const ETATS_HORLOGE = ['synchronise', 'derive', 'non_synchronise', 'indisponible'] as const;
export type EtatHorlogeStatut = (typeof ETATS_HORLOGE)[number];

/** Dérive au-delà de laquelle on avertit, en millisecondes. */
export const HORLOGE_SEUIL_AVERTISSEMENT_MS = 500;
/** Dérive au-delà de laquelle l'horodatage n'est plus défendable. */
export const HORLOGE_SEUIL_CRITIQUE_MS = 5_000;
/** Sans synchronisation depuis ce délai, l'horloge est réputée non synchronisée. */
export const HORLOGE_AGE_CRITIQUE_MS = 24 * 60 * 60 * 1000;

export interface EtatHorloge {
  statut: EtatHorlogeStatut;
  /** Source de temps retenue par le démon, telle qu'il la nomme. */
  source: string | null;
  /** Décalage estimé avec la source, en millisecondes. Signé. */
  decalageMs: number | null;
  /** Distance à l'horloge de référence. Zéro quand le démon ne la donne pas. */
  stratum: number | null;
  /** Dernière synchronisation constatée. */
  derniereSynchro: string | null;
  /** Date de l'instantané lu, pour dire à quel point il est frais. */
  releveLe: string | null;
  /** Ce qu'un exploitant doit lire quand l'état n'est pas vert. */
  message: string;
}

/** Un serveur de temps déclaré, et ce qu'un test en a appris. */
export interface ResultatTestNtp {
  serveur: string;
  joignable: boolean;
  decalageMs: number | null;
  message: string;
}

/** Une résolution tentée, et son verdict. */
export interface ResultatTestDns {
  cible: string;
  /** Ce que ce nom sert : annuaire, SMTP, source de capture. */
  usage: string;
  resolu: boolean;
  adresses: string[];
  message: string;
}

export interface ReglagesReseau {
  /**
   * Fuseau d'affichage du portail, au sens IANA. Il ne touche pas au fuseau de
   * la base, que l'api force à UTC et vérifie au démarrage (§9.27).
   */
  fuseau: string;

  /** Serveurs de temps déclarés. On-prem seulement (§9.36). */
  ntp: {
    serveurs: string[];
    /**
     * Faux tant qu'aucun agent hôte n'écrit la configuration : la valeur est
     * conservée et affichée, elle n'est pas appliquée.
     */
    applique: boolean;
  };

  /** Résolveurs déclarés. On-prem seulement, même logique que `ntp`. */
  dns: {
    primaire: string | null;
    secondaire: string | null;
    domaineRecherche: string | null;
    applique: boolean;
  };

  /**
   * Relais dont l'en-tête `X-Forwarded-For` est cru (§9.16). La variable
   * d'environnement l'emporte : un administrateur ne doit pas pouvoir fausser
   * depuis l'interface l'adresse inscrite au journal d'audit (§9.36).
   */
  proxys: { cidr: string[] };
}

export interface ReglagesReseauResponse {
  reglages: ReglagesReseau;
  version: number;
  mode: ModeDeploiement;
  etatHorloge: EtatHorloge;
  /**
   * Ce que l'api applique réellement pour les relais de confiance, et d'où cela
   * vient. Un champ modifiable sans effet doit le dire, sinon l'administrateur
   * croira avoir réglé ce qu'il n'a pas réglé (§9.36).
   */
  proxysEnVigueur: { valeurs: string[]; source: 'environnement' | 'base' };
  updatedAt: string | null;
  updatedByEmail: string | null;
}

/** Écriture d'une section : la version lue accompagne la modification. */
export interface MajReglagesReseauRequest {
  reglages: ReglagesReseau;
  version: number;
}
