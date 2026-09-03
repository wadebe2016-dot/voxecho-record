import type { ReactNode } from 'react';
import { useAuth } from '../auth/auth-context';
import { libelleRole } from '../lib/format';
import { NavigationPrincipale } from './NavigationPrincipale';

/** Bandeau locataire + navigation filtrée par rôle (masquage d'affichage). */
export function AppShell({ children }: { children: ReactNode }) {
  const { profil, deconnexion } = useAuth();

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-ardoise-200 bg-ardoise-900 text-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
          <span className="text-sm font-semibold tracking-tight">VoxEcho Record</span>
          <span
            className="rounded bg-ardoise-800 px-2 py-0.5 text-xs text-ardoise-100"
            data-testid="bandeau-locataire"
          >
            {profil?.tenantName ?? '—'}
          </span>
          <NavigationPrincipale />
          <div className="ml-auto flex items-center gap-3 text-xs text-ardoise-200">
            <span>
              {profil?.email} · {libelleRole(profil?.role ?? '')}
            </span>
            <button
              type="button"
              onClick={() => void deconnexion()}
              className="rounded border border-ardoise-600 px-2 py-1 hover:bg-ardoise-800"
            >
              Se déconnecter
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">{children}</div>
    </div>
  );
}
