import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DashboardResponse } from '@voxecho/shared';
import { TableauDeBordPage } from '../src/pages/TableauDeBordPage';
import { afficher, reponse, simulerApi } from './helpers';

/** Trente jours dont deux chargés : la fenêtre entière, jours creux compris. */
function jours(): DashboardResponse['volumeParJour'] {
  return Array.from({ length: 30 }, (_, index) => {
    const jour = `2026-08-${String(index + 1).padStart(2, '0')}`;
    if (index === 10) return { jour, appels: 12, dureeSec: 1_320, octets: 21_120_000 };
    if (index === 20) return { jour, appels: 4, dureeSec: 240, octets: 3_840_000 };
    return { jour, appels: 0, dureeSec: 0, octets: 0 };
  });
}

const TABLEAU: DashboardResponse = {
  totaux: {
    appelsConserves: 16,
    dureeSec: 1_560,
    stockageOctets: 24_960_000,
    sousConservationForcee: 2,
    appelsPurges: 3,
  },
  retention: { days: 730, belowFloorReason: null },
  volumeParJour: jours(),
  quarantaines: [
    { id: 'q-1', at: '2026-09-01T13:30:12Z', motif: 'json malformé' },
    { id: 'q-2', at: '2026-09-01T12:00:00Z', motif: 'wav tronqué' },
  ],
};

const servir = (donnees: DashboardResponse) => () => reponse(200, donnees);

/**
 * Tableau de bord — CLAUDE.md §6, et fin du second fil du §9.5.
 *
 * Sobre : des chiffres d'exploitation. Ce que ces tests protègent, c'est que
 * le graphe ne mente pas — jours creux dessinés à zéro, et mêmes données
 * disponibles en chiffres.
 */
describe('tableau de bord', () => {
  it('mène les chiffres d’exploitation en tête', async () => {
    simulerApi({ '/api/dashboard': servir(TABLEAU) });
    afficher(<TableauDeBordPage />);

    expect(await screen.findByText('Appels conservés')).toBeInTheDocument();
    expect(screen.getByText('16')).toBeInTheDocument();
    expect(screen.getByText('Stockage utilisé')).toBeInTheDocument();
    expect(screen.getByText('Sous conservation forcée')).toBeInTheDocument();
    // Un appel purgé garde sa fiche : le dire évite de croire à une perte.
    expect(screen.getByText('fiche conservée, audio détruit')).toBeInTheDocument();
  });

  it('rappelle la conservation en vigueur', async () => {
    simulerApi({ '/api/dashboard': servir(TABLEAU) });
    afficher(<TableauDeBordPage />);
    expect(await screen.findByText('730 jours')).toBeInTheDocument();
  });

  it('signale une politique dérogatoire avant tout le reste', async () => {
    simulerApi({
      '/api/dashboard': servir({
        ...TABLEAU,
        retention: { days: 90, belowFloorReason: 'Filiale cédée.' },
      }),
    });
    afficher(<TableauDeBordPage />);

    expect(await screen.findByText(/dérogation au plancher/)).toHaveTextContent('Filiale cédée.');
  });

  it('dessine une barre par journée de la fenêtre, jours creux compris', async () => {
    simulerApi({ '/api/dashboard': servir(TABLEAU) });
    afficher(<TableauDeBordPage />);

    const graphe = await screen.findByRole('region', { name: /Appels ingérés par jour/ });
    // Trente journées, dont vingt-huit à zéro : le graphe ne saute rien.
    expect(within(graphe).getAllByRole('button')).toHaveLength(30);
    expect(within(graphe).getByLabelText('2026-08-11 : 12 appels')).toBeInTheDocument();
    expect(within(graphe).getByLabelText('2026-08-01 : 0 appel')).toBeInTheDocument();
  });

  it('détaille la journée survolée sans faire lire une barre à l’œil', async () => {
    simulerApi({ '/api/dashboard': servir(TABLEAU) });
    afficher(<TableauDeBordPage />);

    const graphe = await screen.findByRole('region', { name: /Appels ingérés par jour/ });
    await userEvent.hover(within(graphe).getByLabelText('2026-08-11 : 12 appels'));

    const detail = within(graphe).getByRole('status');
    expect(detail).toHaveTextContent('2026-08-11');
    expect(detail).toHaveTextContent('12 appels');
  });

  it('donne les mêmes données en chiffres : la couleur ne porte rien seule', async () => {
    simulerApi({ '/api/dashboard': servir(TABLEAU) });
    afficher(<TableauDeBordPage />);

    const tableau = await screen.findByRole('region', { name: /Détail des journées/ });
    // Seules les journées chargées, la plus récente en tête.
    const lignes = within(tableau).getAllByRole('row').slice(1);
    expect(lignes).toHaveLength(2);
    expect(lignes[0]).toHaveTextContent('2026-08-21');
    expect(lignes[1]).toHaveTextContent('2026-08-11');
  });

  it('liste les derniers dépôts écartés, avec leur motif', async () => {
    simulerApi({ '/api/dashboard': servir(TABLEAU) });
    afficher(<TableauDeBordPage />);

    const bloc = await screen.findByRole('region', { name: /Dernières quarantaines/ });
    expect(within(bloc).getByText('json malformé')).toBeInTheDocument();
    expect(within(bloc).getByText('wav tronqué')).toBeInTheDocument();
  });

  it('distingue « rien à signaler » d’une panne d’affichage', async () => {
    simulerApi({ '/api/dashboard': servir({ ...TABLEAU, quarantaines: [] }) });
    afficher(<TableauDeBordPage />);

    expect(await screen.findByText(/Aucun dépôt écarté récemment/)).toBeInTheDocument();
  });

  it('remonte un refus du serveur plutôt qu’un écran vide', async () => {
    simulerApi({ '/api/dashboard': () => reponse(401, { message: 'Session expirée.' }) });
    afficher(<TableauDeBordPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Session expirée.');
  });
});
