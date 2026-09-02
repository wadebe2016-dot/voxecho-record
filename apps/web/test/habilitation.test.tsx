import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RecordingListItem } from '@voxecho/shared';
import { RecordingsPage } from '../src/pages/RecordingsPage';
import { afficher, profilPour, reponse, simulerApi } from './helpers';

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
  operationCategory: 'confirmation_cheque',
  underHold: false,
};

const LISTE = () => reponse(200, { items: [APPEL], total: 1, page: 1, pageSize: 25, pageCount: 1 });

/**
 * Habilitation d'écoute au portail — CLAUDE.md §9.9.
 *
 * Le masquage n'est qu'un confort d'affichage : l'api refuse de toute façon.
 * Mais montrer à un superviseur un bouton qui rendra 403 ne lui apprend rien,
 * et lui laisser croire qu'il pourrait écouter serait pire.
 */
describe('ce que chaque rôle voit d’un appel', () => {
  async function ouvrirLaFiche(role: 'ADMIN' | 'SUPERVISOR' | 'AUDITOR') {
    simulerApi({ '/api/recordings': LISTE });
    afficher(<RecordingsPage />, profilPour(role));
    await userEvent.click(await screen.findByRole('button', { name: /Consulter l’appel/ }));
  }

  it.each(['ADMIN', 'AUDITOR'] as const)('%s peut écouter et exporter', async (role) => {
    await ouvrirLaFiche(role);
    expect(await screen.findByRole('button', { name: /Écouter cet appel/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Exporter/ })).toBeInTheDocument();
  });

  it('le SUPERVISOR ne se voit offrir ni l’écoute ni l’export', async () => {
    await ouvrirLaFiche('SUPERVISOR');
    await screen.findByRole('heading', { name: /Appel 16778001/ });

    expect(screen.queryByRole('button', { name: /Écouter cet appel/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Exporter/ })).not.toBeInTheDocument();
  });

  it('et on lui dit pourquoi, plutôt que de laisser un vide', async () => {
    await ouvrirLaFiche('SUPERVISOR');
    expect(await screen.findByText(/pas à son contenu/)).toBeInTheDocument();
  });

  it('le SUPERVISOR garde les métadonnées et l’empreinte : constater n’est pas entendre', async () => {
    await ouvrirLaFiche('SUPERVISOR');
    // Portée à la fiche : le formulaire de recherche propose la même
    // catégorie dans sa liste déroulante.
    const fiche = await screen.findByRole('region', { name: /Appel 16778001/ });
    expect(within(fiche).getByText(APPEL.sha256)).toBeInTheDocument();
    expect(within(fiche).getByText('Confirmation de chèque')).toBeInTheDocument();
  });
});
