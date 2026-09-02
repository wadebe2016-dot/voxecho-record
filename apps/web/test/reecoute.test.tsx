import { describe, expect, it } from 'vitest';
import type { vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RecordingListItem } from '@voxecho/shared';
import { RecordingsPage } from '../src/pages/RecordingsPage';
import { afficher, reponse, simulerApi } from './helpers';

const EMPREINTE = 'ab12'.repeat(16);

const APPEL: RecordingListItem = {
  id: 'r-1',
  refci: '16778001',
  near: '1001',
  far: '699112233',
  direction: 'outbound',
  startedAt: '2026-09-01T13:30:12Z',
  durationSec: 183,
  sha256: EMPREINTE,
  sizeBytes: 2_928_000,
  source: 'cucm-bib',
  status: 'stored',
  underHold: false,
};

const LISTE = () => reponse(200, { items: [APPEL], total: 1, page: 1, pageSize: 25, pageCount: 1 });

/**
 * Réécoute — CLAUDE.md §6. Ce qui se joue ici n'est pas l'ergonomie d'un
 * lecteur : c'est la fidélité du journal d'audit. Une écoute inscrite est une
 * écoute demandée, et une écoute demandée est inscrite.
 */
describe('réécoute d’un appel', () => {
  async function ouvrirLaFiche(routes: Record<string, () => Response> = {}) {
    const fetchSimule = simulerApi({ '/api/recordings': LISTE, ...routes });
    afficher(<RecordingsPage />);
    const consulter = await screen.findByRole('button', { name: /Consulter l’appel 16778001/ });
    await userEvent.click(consulter);
    return fetchSimule;
  }

  it('ouvre la fiche sans déclencher d’écoute', async () => {
    const fetchSimule = await ouvrirLaFiche();

    expect(await screen.findByRole('heading', { name: /Appel 16778001/ })).toBeInTheDocument();
    // Consulter une fiche n'est pas écouter : le journal ne doit pas
    // enregistrer une écoute pour qui vient relever une empreinte.
    expect(appelsA(fetchSimule, '/api/recordings/r-1/listen')).toHaveLength(0);
  });

  it('affiche l’empreinte en entier, là où la liste l’abrège', async () => {
    await ouvrirLaFiche();

    expect(await screen.findByText(EMPREINTE)).toBeInTheDocument();
  });

  it('ouvre l’écoute et branche le lecteur sur le flux, billet en main', async () => {
    const fetchSimule = await ouvrirLaFiche({
      '/api/recordings/r-1/listen': () => reponse(200, { ticket: 'billet-123', expiresIn: '30m' }),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Écouter cet appel' }));

    const lecteur = await screen.findByLabelText('Lecture de l’appel 16778001');
    expect(lecteur).toHaveAttribute(
      'src',
      `${window.location.origin}/api/recordings/r-1/audio?ticket=billet-123`,
    );
    expect(appelsA(fetchSimule, '/api/recordings/r-1/listen')).toHaveLength(1);
  });

  it('annonce à l’auditeur que son écoute est tracée', async () => {
    await ouvrirLaFiche({
      '/api/recordings/r-1/listen': () => reponse(200, { ticket: 'billet-123', expiresIn: '30m' }),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Écouter cet appel' }));

    expect(await screen.findByText(/inscrite au journal d’audit/)).toBeInTheDocument();
  });

  it('compte une ouverture d’écoute par demande, pas une par requête du lecteur', async () => {
    const fetchSimule = await ouvrirLaFiche({
      '/api/recordings/r-1/listen': () => reponse(200, { ticket: 'billet-123', expiresIn: '30m' }),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Écouter cet appel' }));
    await screen.findByLabelText('Lecture de l’appel 16778001');

    // Le lecteur réclame ensuite ses tranches tout seul : le portail
    // n'ouvre pas d'écoute supplémentaire.
    expect(appelsA(fetchSimule, '/api/recordings/r-1/listen')).toHaveLength(1);
  });

  it('reprend le message du serveur quand l’audio n’existe plus', async () => {
    await ouvrirLaFiche({
      '/api/recordings/r-1/listen': () =>
        reponse(410, { message: 'Enregistrement purgé : l’audio n’existe plus.' }),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Écouter cet appel' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enregistrement purgé : l’audio n’existe plus.',
    );
    expect(screen.queryByLabelText('Lecture de l’appel 16778001')).not.toBeInTheDocument();
  });

  it('referme la fiche sans laisser le lecteur derrière elle', async () => {
    await ouvrirLaFiche({
      '/api/recordings/r-1/listen': () => reponse(200, { ticket: 'billet-123', expiresIn: '30m' }),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Écouter cet appel' }));
    await screen.findByLabelText('Lecture de l’appel 16778001');
    await userEvent.click(screen.getByRole('button', { name: 'Fermer' }));

    await waitFor(() => {
      expect(screen.queryByLabelText('Lecture de l’appel 16778001')).not.toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: /Appel 16778001/ })).not.toBeInTheDocument();
  });
});

/** Requêtes effectivement émises vers un chemin donné. */
function appelsA(fetchSimule: ReturnType<typeof vi.fn>, chemin: string): unknown[] {
  return fetchSimule.mock.calls.filter(
    (appel) => new URL(String(appel[0]), 'http://localhost').pathname === chemin,
  );
}
