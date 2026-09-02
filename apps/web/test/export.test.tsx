import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
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
  underHold: false,
};

const LISTE = () => reponse(200, { items: [APPEL], total: 1, page: 1, pageSize: 25, pageCount: 1 });

/** Réponse binaire, telle que le serveur rend une archive. */
function archive(integrite: 'concordante' | 'divergente'): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      'Content-Disposition': 'attachment; filename="export-appel.zip"',
      'X-Export-Integrite': integrite,
    }),
    blob: () => Promise.resolve(new Blob(['zip'], { type: 'application/zip' })),
    json: () => Promise.resolve(null),
  } as unknown as Response;
}

/**
 * Export horodaté — CLAUDE.md §6 et §9.8.
 *
 * Ce qui se joue ici : l'export ne part qu'à la demande — il s'inscrit au
 * journal — et le portail ne présente jamais comme intacte une pièce dont
 * l'empreinte a divergé.
 */
describe('export d’un appel', () => {
  beforeEach(() => {
    // jsdom n'implémente ni les urls d'objet ni le téléchargement. On greffe
    // les deux méthodes manquantes sur `URL` plutôt que de le remplacer : le
    // client d'api s'en sert comme constructeur pour bâtir ses requêtes.
    URL.createObjectURL = vi.fn(() => 'blob:faux');
    URL.revokeObjectURL = vi.fn();
    HTMLAnchorElement.prototype.click = vi.fn();
  });

  async function ouvrirLaFiche(routes: Record<string, () => Response> = {}) {
    const fetchSimule = simulerApi({ '/api/recordings': LISTE, ...routes });
    afficher(<RecordingsPage />);
    await userEvent.click(await screen.findByRole('button', { name: /Consulter l’appel/ }));
    return fetchSimule;
  }

  it('n’exporte rien à l’ouverture de la fiche', async () => {
    const fetchSimule = await ouvrirLaFiche();
    await screen.findByRole('heading', { name: /Appel 16778001/ });

    const appels = fetchSimule.mock.calls.map((appel) => String(appel[0]));
    expect(appels.some((url) => url.includes('/export'))).toBe(false);
  });

  it('annonce ce que contient l’archive et qu’elle est tracée', async () => {
    await ouvrirLaFiche();
    const mention = await screen.findByText(/Archive ZIP/);
    expect(mention).toHaveTextContent(/fiche PDF/);
    expect(mention).toHaveTextContent(/SHA-256/);
    expect(mention).toHaveTextContent(/journal d’audit/);
  });

  it('demande l’archive au bouton, et confirme l’empreinte vérifiée', async () => {
    const fetchSimule = await ouvrirLaFiche({
      '/api/recordings/r-1/export': () => archive('concordante'),
    });

    await userEvent.click(await screen.findByRole('button', { name: /Exporter/ }));

    await waitFor(() => {
      const appel = fetchSimule.mock.calls.find((c) => String(c[0]).includes('/export'));
      expect(appel).toBeDefined();
      expect((appel?.[1] as RequestInit).method).toBe('POST');
    });

    expect(await screen.findByText(/Empreinte vérifiée au moment de l’export/)).toBeInTheDocument();
  });

  it('ne présente pas comme intacte une pièce dont l’empreinte a divergé', async () => {
    await ouvrirLaFiche({ '/api/recordings/r-1/export': () => archive('divergente') });

    await userEvent.click(await screen.findByRole('button', { name: /Exporter/ }));

    const alerte = await screen.findByRole('alert');
    expect(alerte).toHaveTextContent(/Empreinte divergente/);
    expect(alerte).toHaveTextContent(/ne peut pas être présenté comme une pièce intacte/);
    expect(screen.queryByText(/Empreinte vérifiée/)).not.toBeInTheDocument();
  });

  it('remonte le refus du serveur sans prétendre avoir exporté', async () => {
    await ouvrirLaFiche({
      '/api/recordings/r-1/export': () =>
        reponse(410, { message: 'Enregistrement purgé : il n’y a plus d’audio à exporter.' }),
    });

    await userEvent.click(await screen.findByRole('button', { name: /Exporter/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/plus d’audio à exporter/);
    expect(screen.queryByText(/Empreinte vérifiée/)).not.toBeInTheDocument();
  });

  it('n’offre pas d’exporter un appel purgé', async () => {
    simulerApi({
      '/api/recordings': () =>
        reponse(200, {
          items: [{ ...APPEL, status: 'purged' }],
          total: 1,
          page: 1,
          pageSize: 25,
          pageCount: 1,
        }),
    });
    afficher(<RecordingsPage />);
    await userEvent.click(await screen.findByRole('button', { name: /Consulter l’appel/ }));

    expect(await screen.findByRole('button', { name: /Exporter/ })).toBeDisabled();
  });
});
