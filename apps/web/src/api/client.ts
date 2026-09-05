import type {
  AuditEventItem,
  AuditListQuery,
  DashboardResponse,
  ExportIntegrite,
  InstanceInfoResponse,
  InstanceSettingsResponse,
  EtatHorloge,
  MajReglagesReseauRequest,
  ReglagesReseauResponse,
  ResultatTestDns,
  ResultatTestNtp,
  LegalHoldResponse,
  PurgeReportDetail,
  PurgeReportSummary,
  ReleaseLegalHoldRequest,
  RetentionPolicySetResponse,
  SetRetentionRequest,
  PolicyVersionDetail,
  PolicyVersionSummary,
  RecordingPolicy,
  Role,
  TemporaryPasswordResponse,
  UpdateUserRequest,
  UserSummary,
  ListenTicketResponse,
  LoginRequest,
  Page,
  ProfileResponse,
  RecordingListItem,
  RecordingListQuery,
  TokenPairResponse,
} from '@voxecho/shared';

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * Détails rendus par l'api quand un refus en compte plusieurs — une
     * politique de mot de passe, par exemple. Les afficher évite de laisser
     * l'utilisateur deviner ce qu'on attend de lui (§9.26).
     */
    readonly details?: string[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Jetons en `sessionStorage` : sur un poste partagé — le cas d'un service
 * conformité — la session ne doit pas survivre à la fermeture de l'onglet.
 */
const CLE_ACCES = 'voxecho.accessToken';
const CLE_RAFRAICHISSEMENT = 'voxecho.refreshToken';

export const jetons = {
  acces: (): string | null => lire(CLE_ACCES),
  rafraichissement: (): string | null => lire(CLE_RAFRAICHISSEMENT),
  enregistrer(paire: TokenPairResponse): void {
    ecrire(CLE_ACCES, paire.accessToken);
    ecrire(CLE_RAFRAICHISSEMENT, paire.refreshToken);
  },
  effacer(): void {
    ecrire(CLE_ACCES, null);
    ecrire(CLE_RAFRAICHISSEMENT, null);
  },
};

function lire(cle: string): string | null {
  try {
    return sessionStorage.getItem(cle);
  } catch {
    return null;
  }
}

function ecrire(cle: string, valeur: string | null): void {
  try {
    if (valeur === null) sessionStorage.removeItem(cle);
    else sessionStorage.setItem(cle, valeur);
  } catch {
    // Stockage indisponible (navigation privée verrouillée) : la session
    // reste en mémoire pour la durée de la page.
  }
}

interface Options {
  method?: string;
  body?: unknown;
  auth?: boolean;
  query?: Record<string, string | number | undefined>;
}

async function appeler<T>(chemin: string, options: Options = {}): Promise<T> {
  const { method = 'GET', body, auth = true, query } = options;
  const url = new URL(`${BASE}/api${chemin}`, window.location.origin);
  for (const [cle, valeur] of Object.entries(query ?? {})) {
    if (valeur !== undefined) url.searchParams.set(cle, String(valeur));
  }

  const entetes: Record<string, string> = {};
  if (body !== undefined) entetes['Content-Type'] = 'application/json';
  const acces = jetons.acces();
  if (auth && acces) entetes.Authorization = `Bearer ${acces}`;

  const reponse = await fetch(url.toString(), {
    method,
    headers: entetes,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (reponse.status === 204) return undefined as T;

  const charge: unknown = await reponse.json().catch(() => null);
  if (!reponse.ok) {
    const details = (charge as { details?: unknown } | null)?.details;
    throw new ApiError(
      reponse.status,
      messageDErreur(charge, reponse.status),
      Array.isArray(details) ? details.map(String) : undefined,
    );
  }
  return charge as T;
}

function messageDErreur(charge: unknown, status: number): string {
  const message = (charge as { message?: unknown } | null)?.message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message) && typeof message[0] === 'string') return message[0];
  if (status === 401) return 'Session expirée. Veuillez vous reconnecter.';
  return 'Le service est momentanément indisponible.';
}

export const api = {
  /**
   * Ce que le portail apprend avant toute connexion (§9.18) : sert à dire, sur
   * l'écran de connexion, qu'on regarde une version d'évaluation. Sans jeton.
   */
  instance: (): Promise<InstanceInfoResponse> => appeler('/instance', { auth: false }),

  connexion: (identifiants: LoginRequest): Promise<TokenPairResponse> =>
    appeler('/auth/login', { method: 'POST', body: identifiants, auth: false }),

  rafraichir: (refreshToken: string): Promise<TokenPairResponse> =>
    appeler('/auth/refresh', { method: 'POST', body: { refreshToken }, auth: false }),

  deconnexion: (refreshToken: string | null): Promise<void> =>
    appeler('/auth/logout', { method: 'POST', body: { refreshToken: refreshToken ?? undefined } }),

  profil: (): Promise<ProfileResponse> => appeler('/auth/me'),

  /** Renouvellement du mot de passe : rend une paire de jetons neuve (§9.26). */
  changerMotDePasse: (ancien: string, nouveau: string): Promise<TokenPairResponse> =>
    appeler('/auth/password', { method: 'POST', body: { ancien, nouveau } }),

  /** Comptes du locataire — CLAUDE.md §9.26. */
  comptes: (): Promise<UserSummary[]> => appeler('/users'),

  creerCompte: (email: string, role: Role): Promise<TemporaryPasswordResponse> =>
    appeler('/users', { method: 'POST', body: { email, role } }),

  modifierCompte: (id: string, modification: UpdateUserRequest): Promise<UserSummary> =>
    appeler(`/users/${id}`, { method: 'PATCH', body: modification }),

  reinitialiserCompte: (id: string): Promise<TemporaryPasswordResponse> =>
    appeler(`/users/${id}/reinitialiser`, { method: 'POST' }),

  /** Réglages de l'instance, en lecture seule (§9.22). */
  reglagesInstance: (): Promise<InstanceSettingsResponse> => appeler('/administration/reglages'),

  /** Onglet Réseau — CLAUDE.md §9.36. */
  reglagesReseau: (): Promise<ReglagesReseauResponse> => appeler('/administration/reseau'),

  definirReglagesReseau: (demande: MajReglagesReseauRequest): Promise<ReglagesReseauResponse> =>
    appeler('/administration/reseau', { method: 'PUT', body: demande }),

  testerNtp: (): Promise<ResultatTestNtp[]> =>
    appeler('/administration/reseau/test/ntp', { method: 'POST' }),

  testerDns: (): Promise<ResultatTestDns[]> =>
    appeler('/administration/reseau/test/dns', { method: 'POST' }),

  /**
   * État de l'horloge, ouvert aux trois rôles : le bandeau qui prévient d'un
   * horodatage non fiable s'affiche en tête de toute la console (§9.36).
   */
  horloge: (): Promise<EtatHorloge> => appeler('/administration/reseau/horloge'),

  /** Politiques d'enregistrement — CLAUDE.md §9.23. */
  politiques: (): Promise<PolicyVersionSummary[]> => appeler('/policies'),

  /**
   * La politique appliquée. Nulle tant qu'aucune n'a été publiée : c'est alors
   * le défaut du produit qui vaut, et il enregistre tout.
   */
  politiqueEnVigueur: (): Promise<PolicyVersionDetail | null> =>
    appeler('/policies/en-vigueur').then((valeur) =>
      valeur !== null && Object.keys(valeur as object).length > 0
        ? (valeur as PolicyVersionDetail)
        : null,
    ),

  politiqueBrouillon: (): Promise<PolicyVersionDetail | null> =>
    appeler('/policies/brouillon').then((valeur) =>
      valeur !== null && Object.keys(valeur as object).length > 0
        ? (valeur as PolicyVersionDetail)
        : null,
    ),

  enregistrerBrouillon: (document: RecordingPolicy): Promise<PolicyVersionDetail> =>
    appeler('/policies/brouillon', { method: 'PUT', body: { document } }),

  abandonnerBrouillon: (): Promise<void> => appeler('/policies/brouillon', { method: 'DELETE' }),

  publierPolitique: (note: string): Promise<PolicyVersionDetail> =>
    appeler('/policies/brouillon/publier', { method: 'POST', body: { note } }),

  /** Conservation : la politique générale et celles par catégorie (§9.28). */
  conservation: (): Promise<RetentionPolicySetResponse> => appeler('/retention/ensemble'),

  definirConservation: (demande: SetRetentionRequest): Promise<unknown> =>
    appeler('/retention', { method: 'PUT', body: demande }),

  /** Conservations forcées d'un appel, la plus récente en tête (§9.29). */
  conservationsForcees: (id: string): Promise<LegalHoldResponse[]> =>
    appeler(`/recordings/${id}/holds`),

  poserConservationForcee: (
    id: string,
    reason: string,
    caseReference: string,
  ): Promise<LegalHoldResponse> =>
    appeler(`/recordings/${id}/holds`, { method: 'POST', body: { reason, caseReference } }),

  leverConservationForcee: (
    id: string,
    demande: ReleaseLegalHoldRequest,
  ): Promise<LegalHoldResponse> =>
    appeler(`/recordings/${id}/holds/release`, { method: 'POST', body: demande }),

  /** Rapports de purge — CLAUDE.md §9.7. */
  rapportsPurge: (page = 1): Promise<Page<PurgeReportSummary>> =>
    appeler('/purge/reports', { query: { page } }),

  rapportPurge: (id: string, page = 1, blocked?: boolean): Promise<PurgeReportDetail> =>
    appeler(`/purge/reports/${id}`, {
      query: { page, blocked: blocked === undefined ? undefined : String(blocked) },
    }),

  simulerPurge: (): Promise<PurgeReportSummary> => appeler('/purge/reports', { method: 'POST' }),

  executerPurge: (id: string, reason: string): Promise<PurgeReportSummary> =>
    appeler(`/purge/reports/${id}/execute`, { method: 'POST', body: { reason } }),

  annulerPurge: (id: string): Promise<PurgeReportSummary> =>
    appeler(`/purge/reports/${id}/cancel`, { method: 'POST' }),

  /**
   * Certificat de destruction (§9.31). Comme l'export d'archive, il est
   * réclamé par le portail avec son jeton en en-tête : rien ne passe par
   * l'url. L'empreinte voyage dans `X-Certificat-Sha256`, pour que l'écran
   * puisse la montrer sans rouvrir le fichier.
   */
  certificatPurge: async (id: string, format: 'pdf' | 'csv'): Promise<ArchiveExportee> => {
    const url = new URL(`${BASE}/api/purge/reports/${id}/certificat`, window.location.origin);
    url.searchParams.set('format', format);
    const acces = jetons.acces();
    const reponse = await fetch(url.toString(), {
      headers: acces ? { Authorization: `Bearer ${acces}` } : {},
    });
    if (!reponse.ok) {
      const charge: unknown = await reponse.json().catch(() => null);
      throw new ApiError(reponse.status, messageDErreur(charge, reponse.status));
    }
    return {
      contenu: await reponse.blob(),
      nomFichier:
        nomDeFichier(reponse.headers.get('Content-Disposition')) ??
        `certificat-destruction-${id}.${format}`,
      // L'empreinte qui fait foi est celle scellée à la destruction ; le
      // serveur dit si sa reconstruction la reproduit encore (§9.31).
      integrite:
        reponse.headers.get('X-Certificat-Reproduit') === 'non' ? 'divergente' : 'concordante',
      empreinte: reponse.headers.get('X-Certificat-Sha256'),
    };
  },

  enregistrements: (query: RecordingListQuery): Promise<Page<RecordingListItem>> =>
    appeler('/recordings', { query: query as Record<string, string | number | undefined> }),

  /**
   * Ouvre une écoute. C'est cet appel qui inscrit l'`AuditEvent LISTEN` —
   * il n'est donc émis que lorsque l'auditeur demande à entendre l'appel,
   * jamais à l'ouverture d'une fiche.
   */
  ouvrirEcoute: (id: string): Promise<ListenTicketResponse> =>
    appeler(`/recordings/${id}/listen`, { method: 'POST' }),

  /**
   * Demande l'archive d'export et la rend telle quelle.
   *
   * Contrairement à l'écoute (§9.4), rien ne passe par l'url : c'est le
   * portail qui réclame le fichier, avec son jeton en en-tête, et non un
   * `<audio>` incapable d'en porter un. Un export est un aller simple — on
   * attend le fichier entier de toute façon, la lecture par plages n'aurait
   * ici aucun sens.
   */
  tableauDeBord: (): Promise<DashboardResponse> => appeler('/dashboard'),

  journal: (query: AuditListQuery): Promise<Page<AuditEventItem>> =>
    appeler('/audit', { query: query as Record<string, string | number | undefined> }),

  /** Extrait CSV du journal. L'export s'inscrit lui-même au journal (§9.11). */
  exporterJournal: async (query: AuditListQuery): Promise<ArchiveExportee> => {
    const url = new URL(`${BASE}/api/audit/export.csv`, window.location.origin);
    for (const [cle, valeur] of Object.entries(query)) {
      if (valeur !== undefined && valeur !== '') url.searchParams.set(cle, String(valeur));
    }
    const acces = jetons.acces();
    const reponse = await fetch(url.toString(), {
      headers: acces ? { Authorization: `Bearer ${acces}` } : {},
    });
    if (!reponse.ok) {
      const charge: unknown = await reponse.json().catch(() => null);
      throw new ApiError(reponse.status, messageDErreur(charge, reponse.status));
    }
    return {
      contenu: await reponse.blob(),
      nomFichier: nomDeFichier(reponse.headers.get('Content-Disposition')) ?? 'journal-audit.csv',
      integrite: 'concordante',
    };
  },

  exporterAppel: async (id: string): Promise<ArchiveExportee> => {
    const url = new URL(`${BASE}/api/recordings/${id}/export`, window.location.origin);
    const acces = jetons.acces();
    const reponse = await fetch(url.toString(), {
      method: 'POST',
      headers: acces ? { Authorization: `Bearer ${acces}` } : {},
    });

    if (!reponse.ok) {
      const charge: unknown = await reponse.json().catch(() => null);
      throw new ApiError(reponse.status, messageDErreur(charge, reponse.status));
    }

    return {
      contenu: await reponse.blob(),
      nomFichier: nomDeFichier(reponse.headers.get('Content-Disposition')) ?? `export-${id}.zip`,
      integrite:
        reponse.headers.get('X-Export-Integrite') === 'divergente' ? 'divergente' : 'concordante',
    };
  },
};

/** Archive telle que le portail la reçoit, avant de la remettre au navigateur. */
export interface ArchiveExportee {
  contenu: Blob;
  nomFichier: string;
  integrite: ExportIntegrite;
  /** Empreinte de la pièce, quand le serveur l'annonce (certificat §9.31). */
  empreinte?: string | null;
}

/** Nom proposé par le serveur dans `Content-Disposition`. */
function nomDeFichier(entete: string | null): string | null {
  const trouve = /filename="([^"]+)"/.exec(entete ?? '');
  return trouve?.[1] ?? null;
}

/**
 * Remet l'archive au navigateur. L'url d'objet est révoquée aussitôt : elle
 * garderait sinon en mémoire tout le contenu d'un appel de dix minutes,
 * pour rien.
 */
export function telecharger(archive: ArchiveExportee): void {
  const url = URL.createObjectURL(archive.contenu);
  const lien = document.createElement('a');
  lien.href = url;
  lien.download = archive.nomFichier;
  document.body.appendChild(lien);
  lien.click();
  lien.remove();
  URL.revokeObjectURL(url);
}

/**
 * Source du lecteur audio. Le billet voyage dans l'url parce qu'un `<audio>`
 * ne peut porter aucun en-tête (CLAUDE.md §9.4) ; il ne vaut que pour cet
 * enregistrement et pour une demi-heure.
 */
export function urlAudio(id: string, ticket: string): string {
  const url = new URL(`${BASE}/api/recordings/${id}/audio`, window.location.origin);
  url.searchParams.set('ticket', ticket);
  return url.toString();
}
