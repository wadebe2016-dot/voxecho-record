/**
 * Certificat de destruction — CLAUDE.md §9.31.
 *
 * Ce que la banque conserve quand les enregistrements, eux, n'existent plus.
 * Il répond à la seule question qu'un contrôleur posera : « qu'avez-vous
 * détruit, quand, au nom de quoi, et sur l'ordre de qui ? »
 *
 * Il est **canonique** : son empreinte porte sur ce contenu, non sur le
 * fichier produit. Le PDF et le CSV du même rapport rendent donc la même
 * valeur, et un certificat présenté des mois plus tard se vérifie.
 */

export const CERTIFICAT_SCHEMA = 1;

export interface CertificatLigne {
  recordingId: string;
  refci: string;
  /** Début de l'appel, tel qu'il était au moment du rapport. */
  debuteLe: string;
  categorie: string;
  /** Durée de conservation qui a décidé du sort de cette pièce, en jours. */
  dureeAppliqueeJours: number;
  octets: number;
  /** Empreinte du fichier détruit : tout ce qu'il en reste. */
  sha256: string;
  /** Vrai quand le fichier manquait déjà au stockage (§9.7). */
  fichierDejaAbsent: boolean;
}

export interface CertificatDestruction {
  schema: number;
  produit: string;
  rapportId: string;
  locataire: { id: string; nom: string };

  /** Politique rejouée à l'exécution : durées par périmètre (§9.28). */
  politiqueAppliquee: Record<string, number>;
  echeance: string;

  demandeLe: string;
  demandePar: string;
  executeLe: string;
  executePar: string;
  motif: string;

  detruits: CertificatLigne[];
  /** Ce qu'une conservation forcée a épargné, avec son motif (§9.7). */
  epargnes: { recordingId: string; refci: string; motifConservation: string | null }[];

  totaux: { detruits: number; octets: number; epargnes: number };
  mention: string;
}
