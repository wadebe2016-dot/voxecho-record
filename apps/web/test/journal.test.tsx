import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AuditEventItem } from '@voxecho/shared';
import { JournalPage } from '../src/pages/JournalPage';
import { afficher, profilPour, reponse, simulerApi } from './helpers';

const ECOUTE: AuditEventItem = {
  id: 'a-1',
  at: '2026-09-01T13:30:12Z',
  action: 'LISTEN',
  actorEmail: 'auditeur@demo.cm',
  tenantId: 't-1',
  recordingId: 'r-1',
  recordingRefci: '16778001',
  ip: '10.0.0.1',
  detail: { refci: '16778001', sha256: 'ab12' },
};

const INGESTION: AuditEventItem = {
  id: 'a-2',
  at: '2026-08-30T09:00:00Z',
  action: 'INGEST',
  actorEmail: null,
  tenantId: 't-1',
  recordingId: 'r-1',
  recordingRefci: '16778001',
  ip: null,
  detail: null,
};

const SYSTEME: AuditEventItem = {
  ...INGESTION,
  id: 'a-3',
  action: 'QUARANTINE',
  tenantId: null,
  recordingId: null,
  recordingRefci: null,
};

const journal = (items: AuditEventItem[]) => () =>
  reponse(200, { items, total: items.length, page: 1, pageSize: 50, pageCount: 1 });

/**
 * Journal d'audit au portail — CLAUDE.md §6, et fin du premier fil laissé
 * ouvert au §9.5 : l'entrée « Journal d'audit » mène désormais quelque part.
 */
describe('journal d’audit', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:faux');
    URL.revokeObjectURL = vi.fn();
    HTMLAnchorElement.prototype.click = vi.fn();
  });

  it('affiche qui a fait quoi, quand, sur quoi et depuis où', async () => {
    simulerApi({ '/api/audit': journal([ECOUTE]) });
    afficher(<JournalPage />);

    const ligne = await screen.findByRole('row', { name: /Écoute/ });
    expect(within(ligne).getByText('auditeur@demo.cm')).toBeInTheDocument();
    expect(within(ligne).getByText('16778001')).toBeInTheDocument();
    expect(within(ligne).getByText('10.0.0.1')).toBeInTheDocument();
    // Le détail est montré tel qu'il a été consigné, sans reformulation.
    expect(within(ligne).getByText(/"sha256":"ab12"/)).toBeInTheDocument();
  });

  it('dit « le système » plutôt que de laisser une case vide', async () => {
    simulerApi({ '/api/audit': journal([INGESTION]) });
    afficher(<JournalPage />);

    const ligne = await screen.findByRole('row', { name: /Ingestion/ });
    expect(within(ligne).getByText('le système')).toBeInTheDocument();
  });

  it('marque les événements qu’aucun locataire ne réclame', async () => {
    simulerApi({ '/api/audit': journal([SYSTEME]) });
    afficher(<JournalPage />, profilPour('ADMIN'));

    const ligne = await screen.findByRole('row', { name: /Quarantaine/ });
    expect(within(ligne).getByText('système')).toBeInTheDocument();
  });

  it('ne filtre qu’à la validation, jamais à la frappe', async () => {
    const fetchSimule = simulerApi({ '/api/audit': journal([ECOUTE]) });
    afficher(<JournalPage />);
    await screen.findByRole('row', { name: /Écoute/ });
    const avant = fetchSimule.mock.calls.length;

    await userEvent.type(screen.getByLabelText('Auteur'), 'auditeur');
    expect(fetchSimule.mock.calls.length).toBe(avant);

    await userEvent.click(screen.getByRole('button', { name: 'Filtrer' }));
    await waitFor(() => {
      const dernier = String(fetchSimule.mock.calls.at(-1)?.[0]);
      expect(dernier).toContain('actor=auditeur');
    });
  });

  it('n’offre le périmètre système qu’à l’ADMIN', async () => {
    simulerApi({ '/api/audit': journal([ECOUTE]) });
    const { unmount } = afficher(<JournalPage />, profilPour('AUDITOR'));
    await screen.findByRole('row', { name: /Écoute/ });
    expect(screen.queryByLabelText('Périmètre')).not.toBeInTheDocument();
    unmount();

    simulerApi({ '/api/audit': journal([ECOUTE]) });
    afficher(<JournalPage />, profilPour('ADMIN'));
    expect(await screen.findByLabelText('Périmètre')).toBeInTheDocument();
  });

  it('extrait en CSV avec les filtres appliqués, et le dit', async () => {
    const csv = {
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Disposition': 'attachment; filename="journal-audit.csv"' }),
      blob: () => Promise.resolve(new Blob(['csv'], { type: 'text/csv' })),
      json: () => Promise.resolve(null),
    } as unknown as Response;

    const fetchSimule = simulerApi({
      '/api/audit': journal([ECOUTE]),
      '/api/audit/export.csv': () => csv,
    });
    afficher(<JournalPage />);
    await screen.findByRole('row', { name: /Écoute/ });

    await userEvent.selectOptions(screen.getByLabelText('Action'), 'LISTEN');
    await userEvent.click(screen.getByRole('button', { name: 'Filtrer' }));
    await userEvent.click(screen.getByRole('button', { name: /Extraire en CSV/ }));

    await waitFor(() => {
      const appel = fetchSimule.mock.calls.find((c) => String(c[0]).includes('export.csv'));
      expect(appel).toBeDefined();
      expect(String(appel?.[0])).toContain('action=LISTEN');
    });

    expect(screen.getByText(/lui-même inscrit au journal/)).toBeInTheDocument();
  });

  it('remonte un refus du serveur sans vider l’écran', async () => {
    simulerApi({
      '/api/audit': () => reponse(403, { message: 'Accès refusé au journal d’audit.' }),
    });
    afficher(<JournalPage />, profilPour('SUPERVISOR'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Accès refusé/);
  });

  it('distingue un journal vide d’un filtre trop étroit', async () => {
    simulerApi({ '/api/audit': journal([]) });
    afficher(<JournalPage />);

    expect(await screen.findByText('Aucun événement')).toBeInTheDocument();
    expect(screen.getByText(/Aucun acte ne répond à ces critères/)).toBeInTheDocument();
  });
});
