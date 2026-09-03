import type { RecordingPolicy } from '../policy/contract.js';

/**
 * Référentiel de politiques d'enregistrement — CLAUDE.md §9.23.
 *
 * Une version publiée est immuable et numérotée : c'est ce numéro qui voyagera
 * avec chaque décision d'enregistrement, et qu'un contrôleur citera pour
 * demander « montrez-moi la politique qui s'appliquait ce jour-là ».
 */

export const POLICY_STATUSES = ['draft', 'published'] as const;
export type PolicyStatus = (typeof POLICY_STATUSES)[number];

/** Une version, telle qu'elle apparaît dans la liste. */
export interface PolicyVersionSummary {
  id: string;
  version: number;
  status: PolicyStatus;
  note: string | null;
  /** Empreinte du document publié ; nulle tant qu'il s'agit d'un brouillon. */
  sha256: string | null;
  createdByEmail: string;
  createdAt: string;
  publishedByEmail: string | null;
  publishedAt: string | null;
  /** Ce que la version contient, en un coup d'œil. */
  resume: {
    parDefaut: string;
    regles: number;
    exclusions: number;
    listes: number;
  };
}

export interface PolicyVersionDetail extends PolicyVersionSummary {
  document: RecordingPolicy;
}

/** Écriture du brouillon : la politique entière, remplacée à chaque fois. */
export interface SavePolicyDraftRequest {
  document: RecordingPolicy;
}

/**
 * Publication. La note n'est pas une formalité : renoncer d'avance à des
 * preuves est un acte qui se motive, comme une dérogation de conservation
 * (§9.6) ou une purge (§9.7).
 */
export interface PublishPolicyRequest {
  note: string;
}
