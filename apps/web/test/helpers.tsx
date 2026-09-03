import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import type { ProfileResponse, Role } from '@voxecho/shared';
import { AuthContext } from '../src/auth/auth-context';

export const PROFIL_AUDITEUR: ProfileResponse = {
  id: 'u-1',
  email: 'auditeur@demo.cm',
  role: 'AUDITOR',
  tenantId: 't-1',
  tenantName: 'Banque de démonstration CEMAC',
  instanceAdmin: false,
  mustChangePassword: false,
};

/** Réponse `fetch` minimale, comme celle du serveur. */
export function reponse(status: number, corps: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(corps),
  } as Response;
}

/** Remplace `fetch` par une table chemin → réponse. */
export function simulerApi(routes: Record<string, () => Response>): ReturnType<typeof vi.fn> {
  const faux = vi.fn((entree: string | URL) => {
    const chemin = new URL(String(entree), 'http://localhost').pathname;
    const gestionnaire = routes[chemin];
    if (!gestionnaire) {
      return Promise.resolve(reponse(404, { message: `route non simulée : ${chemin}` }));
    }
    return Promise.resolve(gestionnaire());
  });
  vi.stubGlobal('fetch', faux);
  return faux;
}

/** Profil d'un rôle donné, pour éprouver ce que chacun voit du portail. */
export function profilPour(role: Role): ProfileResponse {
  return { ...PROFIL_AUDITEUR, id: `u-${role}`, email: `${role.toLowerCase()}@demo.cm`, role };
}

/**
 * Rend un fragment de portail dans son contexte : le routeur et la session.
 * Les composants lisent le rôle pour masquer ce qu'il n'a pas le droit de
 * faire (§9.9) ; sans session, ils ne sauraient pas quoi montrer.
 */
export function afficher(
  element: ReactElement,
  profil: ProfileResponse | null = PROFIL_AUDITEUR,
): RenderResult {
  const session = {
    profil,
    chargement: false,
    connexion: () => Promise.resolve(),
    deconnexion: () => Promise.resolve(),
  };
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <AuthContext.Provider value={session}>{element}</AuthContext.Provider>
    </MemoryRouter>,
  );
}
