/**
 * Export horodaté — CLAUDE.md §6 et §9.8.
 *
 * Un export est ce qui **sort** du produit : une pièce qui circulera par
 * courriel, sur une clé, dans un dossier de contrôle, loin du portail qui l'a
 * produite. Elle doit donc se suffire à elle-même — dire de quel appel il
 * s'agit, qui l'a demandée, quand, et ce que valait l'empreinte au moment où
 * elle a quitté le coffre.
 *
 * Les clés de la fiche sont en français : ce n'est pas un objet d'API, c'est
 * un document que lit un contrôleur. C'est la même convention que le `detail`
 * du journal d'audit.
 */

/** Version du format de fiche, pour qu'un export ancien reste lisible. */
export const EXPORT_MANIFEST_VERSION = 1;

/** Noms des pièces dans l'archive. Le wav garde le nom sous lequel il est rangé. */
export const EXPORT_FICHE_JSON = 'fiche.json';
export const EXPORT_FICHE_PDF = 'fiche.pdf';

/**
 * Résultat de la vérification d'intégrité faite **au moment de l'export**.
 *
 * `concordante` : le fichier servi a l'empreinte relevée à l'ingestion.
 * `divergente` : il ne l'a plus. L'export n'est pas refusé pour autant — il
 * faut bien pouvoir sortir la pièce pour enquêter sur ce qui lui est arrivé —
 * mais la fiche le dit en toutes lettres, et le journal le consigne.
 */
export const EXPORT_INTEGRITES = ['concordante', 'divergente'] as const;
export type ExportIntegrite = (typeof EXPORT_INTEGRITES)[number];

export interface ExportManifest {
  schema: number;
  produit: string;
  /** Identifiant de cet export, repris au journal d'audit. */
  exportId: string;
  emisLe: string;
  demandeur: {
    id: string;
    email: string;
    role: string;
  };
  locataire: {
    id: string;
    nom: string;
  };
  appel: {
    id: string;
    refci: string;
    poste: string;
    correspondant: string;
    sens: string;
    debuteLe: string;
    dureeSec: number;
    source: string;
    statut: string;
    sousConservationForcee: boolean;
  };
  preuve: {
    /** Empreinte relevée à l'ingestion, celle qui fait foi. */
    sha256Ingestion: string;
    /** Empreinte recalculée sur le fichier exporté, à l'instant de l'export. */
    sha256Export: string;
    integrite: ExportIntegrite;
    octets: number;
    fichierAudio: string;
  };
  mention: string;
}

/** Ce que le portail apprend d'un export sans ouvrir l'archive. */
export interface ExportResultHeaders {
  exportId: string;
  integrite: ExportIntegrite;
  nomArchive: string;
}
