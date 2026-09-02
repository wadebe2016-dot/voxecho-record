import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/auth-context';
import { libelleRole } from '../lib/format';
import { peut, type Capacite } from '../lib/permissions';

interface Entree {
  chemin: string;
  libelle: string;
  capacite: Capacite;
}

const NAVIGATION: Entree[] = [
  { chemin: '/tableau-de-bord', libelle: 'Tableau de bord', capacite: 'consulterTableauDeBord' },
  { chemin: '/enregistrements', libelle: 'Enregistrements', capacite: 'consulterEnregistrements' },
  { chemin: '/journal', libelle: 'Journal d’audit', capacite: 'consulterJournalAudit' },
];

/** Bandeau locataire + navigation filtrée par rôle (masquage d'affichage). */
export function AppShell({ children }: { children: ReactNode }) {
  const { profil, deconnexion } = useAuth();
  const entrees = NAVIGATION.filter((entree) => peut(profil?.role, entree.capacite));

  return (
    <div className="flex min-h-full flex-col">
      <header className="border-b border-ardoise-200 bg-ardoise-900 text-white">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-2.5">
          <span className="text-sm font-semibold tracking-tight">VoxEcho Record</span>
          <span
            className="rounded bg-ardoise-800 px-2 py-0.5 text-xs text-ardoise-100"
            data-testid="bandeau-locataire"
          >
            {profil?.tenantName ?? '—'}
          </span>
          <nav className="flex gap-4 text-sm" aria-label="Navigation principale">
            {entrees.map((entree) => (
              <NavLink
                key={entree.chemin}
                to={entree.chemin}
                className={({ isActive }) =>
                  isActive
                    ? 'text-white underline underline-offset-4'
                    : 'text-ardoise-200 hover:text-white'
                }
              >
                {entree.libelle}
              </NavLink>
            ))}
          </nav>
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
