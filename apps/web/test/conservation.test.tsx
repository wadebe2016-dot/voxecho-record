import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RecordingListItem } from '@voxecho/shared';
import { RecordingsPage } from '../src/pages/RecordingsPage';
import { afficher, reponse, simulerApi } from './helpers';

const APPEL: RecordingListItem = {
  id: 'r-1',
  refci: '16778001',
  near: '1001',
  far: '699112233',
  direction: 'outbound',
  startedAt: '2026-09-01T13:30:12Z',
  durationSec: 183,
  sha256: 'ab12'.repeat(16),
  sizeBytes: 2_928_000,
  source: 'cucm-bib',
  status: 'stored',
  operationCategory: 'autre',
  underHold: false,
};

const liste = (appel: RecordingListItem) => () =>
  reponse(200, { items: [appel], total: 1, page: 1, pageSize: 25, pageCount: 1 });

/**
 * Conservation forcée — CLAUDE.md §5 et §9.6.
 *
 * Un hold soustrait un appel à la purge. C'est un état qui change ce que
 * l'appel devient : il doit se voir, sinon un auditeur croit lire un appel
 * ordinaire là où une mesure court.
 */
describe('conservation forcée au portail', () => {
  it('ne signale rien sur un appel ordinaire', async () => {
    simulerApi({ '/api/recordings': liste(APPEL) });
    afficher(<RecordingsPage />);

    expect(await screen.findByText('Conservé')).toBeInTheDocument();
    expect(screen.queryByText(/conservation forcée/i)).not.toBeInTheDocument();
  });

  it('marque l’appel dans la liste sans effacer son statut de fichier', async () => {
    simulerApi({ '/api/recordings': liste({ ...APPEL, underHold: true }) });
    afficher(<RecordingsPage />);

    expect(await screen.findByText('conservation forcée')).toBeInTheDocument();
    // Le statut du fichier reste lisible à côté : le hold ne s'y substitue
    // pas, c'est une mesure qui s'ajoute, pas un état de stockage.
    expect(screen.getByText('Conservé')).toBeInTheDocument();
  });

  it('annonce la mesure sur la fiche, et dit ce qu’elle emporte', async () => {
    simulerApi({ '/api/recordings': liste({ ...APPEL, underHold: true }) });
    afficher(<RecordingsPage />);

    await userEvent.click(await screen.findByRole('button', { name: /Consulter l’appel/ }));

    const mesure = await screen.findByRole('status');
    expect(mesure).toHaveTextContent(/Sous conservation forcée/);
    expect(mesure).toHaveTextContent(/soustrait à la purge automatique/);
  });
});
