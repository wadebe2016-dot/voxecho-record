import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/auth-context';
import { peut, type Capacite } from '../lib/permissions';

/**
 * Navigation principale — CLAUDE.md §9.25.
 *
 * Un seul modèle pour toute l'interface : un onglet sans sous-section est un
 * lien, un onglet qui en a s'ouvre au clic par-dessus le contenu. Pas de menu
 * latéral : il serrait les listes denses, et faisait cohabiter deux façons de
 * naviguer selon l'écran où l'on se trouvait.
 *
 * Seules les entrées qui existent sont affichées ; les sections se remplissent
 * lot par lot.
 */

interface Lien {
  chemin: string;
  libelle: string;
  capacite: Capacite;
  /** Réservé à l'administrateur de l'instance (§9.22). */
  instanceSeulement?: boolean;
}

interface Groupe {
  libelle: string;
  /** Sous-sections, chacune titrée dans le déroulant. */
  sections: { titre: string; liens: Lien[] }[];
}

type Entree = Lien | Groupe;

const estGroupe = (entree: Entree): entree is Groupe => 'sections' in entree;

const NAVIGATION: Entree[] = [
  { chemin: '/tableau-de-bord', libelle: 'Tableau de bord', capacite: 'consulterTableauDeBord' },
  { chemin: '/enregistrements', libelle: 'Enregistrements', capacite: 'consulterEnregistrements' },
  { chemin: '/journal', libelle: 'Journal d’audit', capacite: 'consulterJournalAudit' },
  { chemin: '/politiques', libelle: 'Politiques', capacite: 'consulterPolitiques' },
  {
    libelle: 'Administration',
    sections: [
      {
        titre: 'Accès',
        liens: [{ chemin: '/comptes', libelle: 'Comptes', capacite: 'gererComptes' }],
      },
      {
        titre: 'Instance',
        liens: [
          {
            chemin: '/administration',
            libelle: 'Réglages',
            capacite: 'administrerInstance',
            instanceSeulement: true,
          },
        ],
      },
    ],
  },
];

function autorise(lien: Lien, role: string | undefined, instanceAdmin: boolean): boolean {
  return peut(role as never, lien.capacite) && (lien.instanceSeulement !== true || instanceAdmin);
}

const CLASSE_LIEN = (actif: boolean): string =>
  actif ? 'text-white underline underline-offset-4' : 'text-ardoise-200 hover:text-white';

function Deroulant({ groupe, sections }: { groupe: string; sections: Groupe['sections'] }) {
  const [ouvert, setOuvert] = useState(false);
  const conteneur = useRef<HTMLDivElement>(null);
  const emplacement = useLocation();

  // Referme au clic ailleurs et à Échap : un menu qui reste ouvert derrière
  // l'écran suivant est un menu qu'on finit par cliquer sans le vouloir.
  useEffect(() => {
    if (!ouvert) return undefined;
    const auClic = (evenement: MouseEvent): void => {
      if (!conteneur.current?.contains(evenement.target as Node)) setOuvert(false);
    };
    const auClavier = (evenement: KeyboardEvent): void => {
      if (evenement.key === 'Escape') setOuvert(false);
    };
    document.addEventListener('mousedown', auClic);
    document.addEventListener('keydown', auClavier);
    return () => {
      document.removeEventListener('mousedown', auClic);
      document.removeEventListener('keydown', auClavier);
    };
  }, [ouvert]);

  useEffect(() => setOuvert(false), [emplacement.pathname]);

  const identifiant = `menu-${groupe.toLowerCase().replace(/\W+/g, '-')}`;

  return (
    <div ref={conteneur} className="relative">
      <button
        type="button"
        aria-expanded={ouvert}
        aria-controls={identifiant}
        onClick={() => setOuvert(!ouvert)}
        className={`${CLASSE_LIEN(false)} inline-flex items-center gap-1`}
      >
        {groupe}
        <span aria-hidden="true" className="text-[0.7em]">
          ▾
        </span>
      </button>

      {ouvert && (
        <div
          id={identifiant}
          // Par-dessus le contenu, jamais à côté : rien n'est serré.
          className="absolute left-0 top-full z-20 mt-1 w-56 rounded border border-ardoise-200 bg-white py-2 text-ardoise-900 shadow-lg"
        >
          {sections.map((section) => (
            <div key={section.titre} className="mb-1 last:mb-0">
              <p className="px-3 py-1 text-xs font-semibold uppercase tracking-wide text-ardoise-400">
                {section.titre}
              </p>
              {section.liens.map((lien) => (
                <NavLink
                  key={lien.chemin}
                  to={lien.chemin}
                  className={({ isActive }) =>
                    `block px-3 py-1.5 text-sm ${
                      isActive ? 'bg-ardoise-100 font-medium' : 'hover:bg-ardoise-50'
                    }`
                  }
                >
                  {lien.libelle}
                </NavLink>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function NavigationPrincipale() {
  const { profil } = useAuth();
  const instanceAdmin = profil?.instanceAdmin === true;

  const entrees = NAVIGATION.map((entree) => {
    if (!estGroupe(entree)) {
      return autorise(entree, profil?.role, instanceAdmin) ? entree : null;
    }
    const sections = entree.sections
      .map((section) => ({
        titre: section.titre,
        liens: section.liens.filter((lien) => autorise(lien, profil?.role, instanceAdmin)),
      }))
      .filter((section) => section.liens.length > 0);
    return sections.length > 0 ? { ...entree, sections } : null;
  }).filter((entree): entree is Entree => entree !== null);

  return (
    // `flex-wrap` plutôt qu'un défilement horizontal : sur petit écran les
    // entrées passent à la ligne, et le déroulant reste entier — un conteneur
    // qui défile couperait ce qui déborde de lui.
    <nav
      className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm"
      aria-label="Navigation principale"
    >
      {entrees.map((entree) =>
        estGroupe(entree) ? (
          <Deroulant key={entree.libelle} groupe={entree.libelle} sections={entree.sections} />
        ) : (
          <NavLink
            key={entree.chemin}
            to={entree.chemin}
            className={({ isActive }) => CLASSE_LIEN(isActive)}
          >
            {entree.libelle}
          </NavLink>
        ),
      )}
    </nav>
  );
}
