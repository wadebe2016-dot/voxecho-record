import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import type { ProfileResponse } from '@voxecho/shared';

export const PROFIL_AUDITEUR: ProfileResponse = {
  id: 'u-1',
  email: 'auditeur@demo.cm',
  role: 'AUDITOR',
  tenantId: 't-1',
  tenantName: 'Banque de démonstration CEMAC',
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

export function afficher(element: ReactElement): RenderResult {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      {element}
    </MemoryRouter>,
  );
}
