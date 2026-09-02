import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
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
  sha256: 'a'.repeat(56) + 'bcdefghi',
  sizeBytes: 2_928_000,
  source: 'cucm-bib',
  status: 'stored',
  operationCategory: 'autre',
  underHold: false,
};

describe('liste des enregistrements', () => {
  it('annonce clairement une liste vide', async () => {
    simulerApi({
      '/api/recordings': () =>
        reponse(200, { items: [], total: 0, page: 1, pageSize: 25, pageCount: 0 }),
    });
    afficher(<RecordingsPage />);

    expect(await screen.findByText('Aucun enregistrement')).toBeInTheDocument();
    expect(screen.getByText(/n’a encore été ingéré pour ce locataire/)).toBeInTheDocument();
  });

  it('affiche les colonnes attendues par un contrôleur', async () => {
    simulerApi({
      '/api/recordings': () =>
        reponse(200, { items: [APPEL], total: 1, page: 1, pageSize: 25, pageCount: 1 }),
    });
    afficher(<RecordingsPage />);

    expect(await screen.findByText('01/09/2026 14:30:12')).toBeInTheDocument();
    // « Sortant » figure aussi dans le sélecteur de sens du formulaire :
    // ce test parle de la ligne du tableau, il vise donc la cellule.
    expect(screen.getByRole('cell', { name: 'Sortant' })).toBeInTheDocument();
    expect(screen.getByText('3:03')).toBeInTheDocument();
    expect(screen.getByText('2,8 Mio')).toBeInTheDocument();
    expect(screen.getByText('Conservé')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Empreinte SHA-256' })).toBeInTheDocument();
  });

  it('conserve l’empreinte entière en info-bulle, même abrégée à l’écran', async () => {
    simulerApi({
      '/api/recordings': () =>
        reponse(200, { items: [APPEL], total: 1, page: 1, pageSize: 25, pageCount: 1 }),
    });
    afficher(<RecordingsPage />);

    const cellule = await screen.findByTitle(APPEL.sha256);
    expect(cellule).toHaveTextContent('aaaaaaaa…bcdefghi');
  });

  it('n’affiche la pagination que lorsqu’il y a plusieurs pages', async () => {
    simulerApi({
      '/api/recordings': () =>
        reponse(200, { items: [APPEL], total: 1, page: 1, pageSize: 25, pageCount: 1 }),
    });
    afficher(<RecordingsPage />);

    await screen.findByText('01/09/2026 14:30:12');
    expect(screen.queryByRole('navigation', { name: 'Pagination' })).not.toBeInTheDocument();
  });

  it('signale une erreur du service sans page blanche', async () => {
    simulerApi({
      '/api/recordings': () =>
        reponse(500, { message: 'Le service est momentanément indisponible.' }),
    });
    afficher(<RecordingsPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Le service est momentanément indisponible.',
    );
  });
});
