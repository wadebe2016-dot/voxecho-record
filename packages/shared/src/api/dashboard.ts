/**
 * Tableau de bord — CLAUDE.md §6 et §9.12.
 *
 * « Volume/jour, durée totale, stockage utilisé, dernières quarantaines. » Ce
 * sont des chiffres d'exploitation : ils disent si la chaîne de capture tourne
 * et ce que pèse la conservation. Rien ici ne dit qui a écouté quoi — c'est le
 * journal d'audit qui le dit, et lui seul.
 */

/** Fenêtre du graphe de volume, en jours pleins de Douala. */
export const DASHBOARD_JOURS = 30;

/** Nombre de quarantaines récentes rappelées sur le tableau de bord. */
export const DASHBOARD_QUARANTAINES = 8;

/** Une journée de la fenêtre. Les jours sans appel valent zéro, pas rien. */
export interface DashboardJour {
  /** Jour local de Douala, `yyyy-mm-dd`. */
  jour: string;
  appels: number;
  dureeSec: number;
  octets: number;
}

export interface DashboardTotaux {
  /** Appels dont l'audio est encore conservé. */
  appelsConserves: number;
  dureeSec: number;
  /** Ce que pèsent les fichiers réellement présents. */
  stockageOctets: number;
  sousConservationForcee: number;
  /** Appels dont l'audio a été détruit ; leur fiche subsiste (§9.7). */
  appelsPurges: number;
}

/** Dépôt écarté à l'ingestion : ce qui n'est jamais entré dans la conservation. */
export interface DashboardQuarantaine {
  id: string;
  at: string;
  motif: string;
}

export interface DashboardResponse {
  totaux: DashboardTotaux;
  retention: {
    days: number;
    /** Non nul quand la politique en vigueur déroge au plancher (§9.6). */
    belowFloorReason: string | null;
  };
  volumeParJour: DashboardJour[];
  quarantaines: DashboardQuarantaine[];
}
