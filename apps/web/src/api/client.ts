import type {
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
};

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
