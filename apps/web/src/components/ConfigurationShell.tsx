import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/auth-context';
import { peut, type Capacite } from '../lib/permissions';

/**
 * Mise en page des écrans de configuration — CLAUDE.md §9.25.
 *
 * Une barre horizontale ne tiendra pas la dizaine d'écrans de réglages à
 * venir ; une sidebar permanente mangerait la largeur des listes d'appels, qui
 * en ont besoin. La configuration a donc son propre menu vertical, et l'usage
 * quotidien garde la pleine page.
 *
 * Seules les entrées qui existent sont affichées : les sections se remplissent
 * lot par lot, et un menu qui annonce des écrans absents fait perdre du temps
 * à qui les cherche.
 */

interface Entree {
  chemin: string;
  libelle: string;
  capacite: Capacite;
  /** Réservée à l'administrateur de l'instance (§9.22). */
  instanceSeulement?: boolean;
}

interface Section {
  titre: string;
  entrees: Entree[];
}

const SECTIONS: Section[] = [
  {
    titre: 'Conformité',
    entrees: [{ chemin: '/politiques', libelle: 'Politiques', capacite: 'consulterPolitiques' }],
  },
  {
    titre: 'Instance',
    entrees: [
      {
        chemin: '/administration',
        libelle: 'Réglages',
        capacite: 'administrerInstance',
        instanceSeulement: true,
      },
    ],
  },
];

/** Les entrées qu'un profil peut réellement ouvrir. */
function sectionsVisibles(
  role: string | undefined,
  instanceAdmin: boolean,
): { titre: string; entrees: Entree[] }[] {
  return SECTIONS.map((section) => ({
    titre: section.titre,
    entrees: section.entrees.filter(
      (entree) =>
        peut(role as never, entree.capacite) &&
        (entree.instanceSeulement !== true || instanceAdmin),
    ),
  })).filter((section) => section.entrees.length > 0);
}

export function ConfigurationShell({ children }: { children: ReactNode }) {
  const { profil } = useAuth();
  const sections = sectionsVisibles(profil?.role, profil?.instanceAdmin === true);

  return (
    <div className="flex gap-6">
      <nav aria-label="Configuration" className="w-48 shrink-0">
        {sections.map((section) => (
          <div key={section.titre} className="mb-4">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-ardoise-400">
              {section.titre}
            </p>
            <ul className="space-y-0.5">
              {section.entrees.map((entree) => (
                <li key={entree.chemin}>
                  <NavLink
                    to={entree.chemin}
                    className={({ isActive }) =>
                      `block rounded px-2 py-1 text-sm ${
                        isActive
                          ? 'bg-ardoise-100 font-medium text-ardoise-900'
                          : 'text-ardoise-700 hover:bg-ardoise-50'
                      }`
                    }
                  >
                    {entree.libelle}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
