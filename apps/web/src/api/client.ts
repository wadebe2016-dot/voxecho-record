import type {
  AuditEventItem,
  AuditListQuery,
  DashboardResponse,
  ExportIntegrite,
  InstanceInfoResponse,
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
    throw new ApiError(reponse.status, messageDErreur(charge, reponse.status));
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
   * l'écran de connexion, qu'on regarde une démonstration. Sans jeton, donc.
   */
  instance: (): Promise<InstanceInfoResponse> => appeler('/instance', { auth: false }),

  connexion: (identifiants: LoginRequest): Promise<TokenPairResponse> =>
    appeler('/auth/login', { method: 'POST', body: identifiants, auth: false }),

  rafraichir: (refreshToken: string): Promise<TokenPairResponse> =>
    appeler('/auth/refresh', { method: 'POST', body: { refreshToken }, auth: false }),

  deconnexion: (refreshToken: string | null): Promise<void> =>
    appeler('/auth/logout', { method: 'POST', body: { refreshToken: refreshToken ?? undefined } }),

  profil: (): Promise<ProfileResponse> => appeler('/auth/me'),

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
