/**
 * Annuaire d'entreprise — CLAUDE.md §9.37.
 *
 * L'annuaire décide **qui entre** et **avec quel rôle**. C'est donc lui qui
 * décide qui peut entendre des conversations de clients, ce qui en fait le
 * réglage le plus lourd de la console après la conservation.
 *
 * Il ne remplace jamais entièrement les comptes locaux : il doit toujours
 * rester un administrateur local actif, faute de quoi un annuaire injoignable
 * fermerait la console à tout le monde.
 */

import type { Role } from '../domain/enums.js';

/** Autorité qui gouverne un compte. */
export const SOURCES_COMPTE = ['local', 'ad'] as const;
export type SourceCompte = (typeof SOURCES_COMPTE)[number];

/** Filtre par défaut, celui d'un Active Directory ordinaire. */
export const ANNUAIRE_FILTRE_DEFAUT = '(&(objectClass=user)(sAMAccountName={login}))';

/** Attributs que le produit lit, et sous quels noms les chercher. */
export interface AttributsAnnuaire {
  login: string;
  email: string;
  nomAffiche: string;
  groupes: string;
}

export const ATTRIBUTS_DEFAUT: AttributsAnnuaire = {
  login: 'sAMAccountName',
  email: 'mail',
  nomAffiche: 'displayName',
  groupes: 'memberOf',
};

/**
 * Une règle de correspondance : un groupe d'annuaire ouvre un rôle, dans un
 * locataire. Un groupe qui doit ouvrir plusieurs locataires fait l'objet de
 * plusieurs règles — un compte n'appartient qu'à un locataire, et une liste
 * dont seul le premier élément compterait serait un piège.
 */
export interface RegleAnnuaire {
  groupeDn: string;
  role: Role;
  tenantId: string;
}

export interface ReglagesAnnuaire {
  actif: boolean;
  url: string | null;
  startTls: boolean;
  /** Faux n'est acceptable qu'en laboratoire, et l'écran le dit. */
  verifierCertificat: boolean;
  /** Autorité de certification interne, au format PEM. */
  acPem: string | null;
  baseDn: string | null;
  bindDn: string | null;
  /** `********` en lecture : l'api ne rend jamais un secret (§9.36). */
  bindMotDePasse: string | null;
  filtre: string;
  attributs: AttributsAnnuaire;
  regles: RegleAnnuaire[];
  synchro: { actif: boolean; intervalleHeures: number };
}

export interface ReglagesAnnuaireResponse {
  reglages: ReglagesAnnuaire;
  version: number;
  updatedAt: string | null;
  updatedByEmail: string | null;
  /** Locataires servis, pour que l'écran propose des règles sans les inventer. */
  locataires: { id: string; nom: string }[];
  /** Dernière synchronisation périodique, et ce qu'elle a fait. */
  derniereSynchro: { le: string; desactives: number; vus: number } | null;
}

/**
 * Écriture. Le mot de passe de liaison n'est envoyé que lorsqu'on le remplace :
 * un champ pré-rempli d'une valeur masquée finirait renvoyé tel quel, et le
 * masque deviendrait le secret.
 */
export interface MajReglagesAnnuaireRequest {
  reglages: Omit<ReglagesAnnuaire, 'bindMotDePasse'>;
  version: number;
  /** Présent seulement pour remplacer le secret ; absent, l'ancien demeure. */
  bindMotDePasse?: string;
}

/** Ce qu'un test de connexion apprend, et qu'on affiche tel quel. */
export interface ResultatTestAnnuaire {
  bind: { reussi: boolean; message: string };
  recherche: {
    tentee: boolean;
    trouve: boolean;
    message: string;
    dn: string | null;
    login: string | null;
    email: string | null;
    nomAffiche: string | null;
    groupes: string[];
  } | null;
  /** Ce que le mappage ferait de cet utilisateur, s'il se connectait. */
  correspondance: { role: Role; tenantId: string; groupeDn: string } | null;
}

export interface TestAnnuaireRequest {
  /** Login à chercher après le bind. Facultatif : on peut ne tester que le bind. */
  login?: string;
}
