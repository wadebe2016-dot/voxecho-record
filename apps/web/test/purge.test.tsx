import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PurgeReportDetail, PurgeReportItem, PurgeReportSummary } from '@voxecho/shared';
import { PurgePage } from '../src/pages/PurgePage';
import { afficher, profilPour, reponse, simulerApi } from './helpers';

const RESUME: PurgeReportSummary = {
  id: 'p-1',
  status: 'simulated',
  policyDays: 730,
  cutoff: '2024-09-02T00:00:00Z',
  policyByScope: { all: 730, operation_change: 3650 },
  candidateCount: 2,
  candidateBytes: 5_856_000,
  blockedCount: 1,
  blockedBytes: 2_928_000,
  createdByEmail: 'admin@banque-meridienne.cm',
  createdAt: '2026-09-01T08:00:00Z',
  executedByEmail: null,
  executedAt: null,
  purgedCount: null,
  purgedBytes: null,
  cancelledByEmail: null,
  cancelledAt: null,
  certificateSha256: null,
};

const item = (reste: Partial<PurgeReportItem>): PurgeReportItem => ({
  recordingId: 'r-1',
  refci: '16778001',
  near: '1001',
  far: '699112233',
  startedAt: '2024-01-15T09:00:00Z',
  durationSec: 183,
  sizeBytes: 2_928_000,
  sha256: 'ab12'.repeat(16),
  outcome: 'candidate',
  operationCategory: 'autre',
  policyDays: 730,
  blocked: false,
  blockingReason: null,
  ...reste,
});

const DETAIL: PurgeReportDetail = {
  ...RESUME,
  items: [
    item({}),
    item({ recordingId: 'r-2', refci: '16778002', operationCategory: 'operation_change' }),
    item({
      recordingId: 'r-3',
      refci: '16778003',
      outcome: 'blocked',
      blocked: true,
      blockingReason: 'Réquisition judiciaire',
    }),
  ],
  itemsTotal: 3,
  page: 1,
  pageSize: 25,
  pageCount: 1,
};

const EXECUTE: PurgeReportDetail = {
  ...DETAIL,
  status: 'executed',
  executedByEmail: 'admin@banque-meridienne.cm',
  executedAt: '2026-09-01T09:00:00Z',
  purgedCount: 2,
  purgedBytes: 5_856_000,
  certificateSha256: 'cd34'.repeat(16),
};

function afficherEcran(
  role: 'ADMIN' | 'SUPERVISOR' | 'AUDITOR' = 'ADMIN',
  routes: Record<string, (init?: RequestInit) => Response> = {},
) {
  const fetchSimule = simulerApi({
    '/api/purge/reports': () =>
      reponse(200, { items: [RESUME], total: 1, page: 1, pageSize: 25, pageCount: 1 }),
    '/api/purge/reports/p-1': () => reponse(200, DETAIL),
    ...routes,
  });
  afficher(<PurgePage />, profilPour(role));
  return fetchSimule;
}

/**
 * Rapports de purge — CLAUDE.md §9.7, §9.28 et §9.31.
 *
 * L'écran ne propose jamais de détruire sans avoir montré ce qui le serait, ni
 * ne présente un rapport comme portant une durée unique quand il en fige
 * plusieurs. Le certificat n'existe que pour une destruction qui a eu lieu.
 */
describe('écran des rapports de purge', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:faux');
    URL.revokeObjectURL = vi.fn();
    HTMLAnchorElement.prototype.click = vi.fn();
  });

  async function ouvrirLeRapport(
    role: 'ADMIN' | 'SUPERVISOR' | 'AUDITOR' = 'ADMIN',
    routes: Record<string, (init?: RequestInit) => Response> = {},
  ) {
    const fetchSimule = afficherEcran(role, routes);
    await userEvent.click(await screen.findByRole('button', { name: 'Ouvrir' }));
    return fetchSimule;
  }

  it('énumère les appels à détruire et ceux qu’une conservation épargne', async () => {
    await ouvrirLeRapport();

    expect(await screen.findByText(/Appels à détruire \(2\)/)).toBeInTheDocument();
    const epargnes = (await screen.findByText(/Épargnés par une conservation forcée \(1\)/))
      .parentElement as HTMLElement;
    // Le motif du hold figure dans le rapport : il doit se lire sans autre
    // source (§9.7).
    expect(within(epargnes).getByText('Réquisition judiciaire')).toBeInTheDocument();
    expect(within(epargnes).getByText('16778003')).toBeInTheDocument();
  });

  it('dit toutes les durées figées, pas seulement la générale', async () => {
    await ouvrirLeRapport();

    // Un rapport où les ordres de change relèvent de dix ans et le reste de
    // deux se lirait autrement comme un rapport à deux ans.
    expect(await screen.findByText(/Générale : 730 j/)).toBeInTheDocument();
    expect(screen.getByText(/Opération de change : 3650 j/)).toBeInTheDocument();
  });

  it('porte sur chaque ligne la durée qui l’a jugée', async () => {
    await ouvrirLeRapport();

    const ligne = (await screen.findByText('16778002')).closest('tr') as HTMLElement;
    expect(within(ligne).getByText('Opération de change')).toBeInTheDocument();
    expect(within(ligne).getByText('730 j')).toBeInTheDocument();
  });

  it('exige un motif d’au moins dix caractères pour exécuter', async () => {
    await ouvrirLeRapport();

    const executer = await screen.findByRole('button', { name: /Exécuter/ });
    expect(executer).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/Motif de la destruction/), 'échéance');
    expect(executer).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/Motif de la destruction/), ' de conservation');
    expect(executer).toBeEnabled();
  });

  it('annonce combien d’enregistrements seront détruits sur le bouton même', async () => {
    await ouvrirLeRapport();

    expect(
      await screen.findByRole('button', { name: /2 enregistrement\(s\) détruit\(s\)/ }),
    ).toBeInTheDocument();
  });

  it('n’offre pas d’exécuter à un superviseur', async () => {
    // Établir un rapport ne détruit rien ; détruire est réservé à l'ADMIN.
    await ouvrirLeRapport('SUPERVISOR');

    expect(await screen.findByRole('heading', { name: /Rapport du/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Établir un rapport' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Exécuter/ })).not.toBeInTheDocument();
  });

  it('laisse l’auditeur lire un rapport sans en établir ni en exécuter', async () => {
    await ouvrirLeRapport('AUDITOR');

    expect(await screen.findByText(/Appels à détruire \(2\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Établir un rapport' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Exécuter/ })).not.toBeInTheDocument();
  });

  it('n’offre aucun certificat pour une destruction qui n’a pas eu lieu', async () => {
    await ouvrirLeRapport();

    expect(await screen.findByRole('heading', { name: /Rapport du/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Télécharger en PDF/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Télécharger en CSV/ })).not.toBeInTheDocument();
  });

  it('propose les deux formats du certificat, et affiche son empreinte', async () => {
    await ouvrirLeRapport('ADMIN', { '/api/purge/reports/p-1': () => reponse(200, EXECUTE) });

    expect(await screen.findByRole('button', { name: 'Télécharger en PDF' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Télécharger en CSV' })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(EXECUTE.certificateSha256 ?? ''))).toBeInTheDocument();
  });

  const certificatServi = (reproduit: 'oui' | 'non') =>
    ({
      ok: true,
      status: 200,
      headers: new Headers({
        'Content-Disposition': 'attachment; filename="certificat-destruction-p-1.csv"',
        'X-Certificat-Sha256': EXECUTE.certificateSha256 ?? '',
        'X-Certificat-Reproduit': reproduit,
      }),
      blob: () => Promise.resolve(new Blob(['csv'], { type: 'text/csv' })),
      json: () => Promise.resolve(null),
    }) as unknown as Response;

  it('ne présente pas comme reproductible un certificat dont l’empreinte ne se retrouve plus', async () => {
    await ouvrirLeRapport('ADMIN', {
      '/api/purge/reports/p-1': () => reponse(200, EXECUTE),
      '/api/purge/reports/p-1/certificat': () => certificatServi('non'),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Télécharger en CSV' }));

    const alerte = await screen.findByRole('alert');
    expect(alerte).toHaveTextContent(/Reconstruction divergente/);
    expect(alerte).toHaveTextContent(/empreinte scellée au moment de la destruction/);
  });

  it('ne signale rien quand la reconstruction concorde', async () => {
    await ouvrirLeRapport('ADMIN', {
      '/api/purge/reports/p-1': () => reponse(200, EXECUTE),
      '/api/purge/reports/p-1/certificat': () => certificatServi('oui'),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Télécharger en CSV' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('demande le certificat au format choisi', async () => {
    const certificat = {
      ok: true,
      status: 200,
      headers: new Headers({
        'Content-Disposition': 'attachment; filename="certificat-destruction-p-1.csv"',
        'X-Certificat-Sha256': EXECUTE.certificateSha256 ?? '',
      }),
      blob: () => Promise.resolve(new Blob(['csv'], { type: 'text/csv' })),
      json: () => Promise.resolve(null),
    } as unknown as Response;

    const fetchSimule = await ouvrirLeRapport('ADMIN', {
      '/api/purge/reports/p-1': () => reponse(200, EXECUTE),
      '/api/purge/reports/p-1/certificat': () => certificat,
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Télécharger en CSV' }));

    const demande = fetchSimule.mock.calls.find((appel) =>
      String(appel[0]).includes('/certificat'),
    );
    expect(String(demande?.[0])).toContain('format=csv');
  });

  it('remonte le refus d’un rapport devenu inexécutable sans prétendre avoir détruit', async () => {
    const conflit =
      'Le rapport ne correspond plus à la réalité : catégorie operation_change suit la générale → 3650 jours. Établissez un nouveau rapport.';
    await ouvrirLeRapport('ADMIN', {
      '/api/purge/reports/p-1/execute': () => reponse(409, { message: conflit }),
    });

    await userEvent.type(
      await screen.findByLabelText(/Motif de la destruction/),
      'Échéance de conservation atteinte',
    );
    await userEvent.click(screen.getByRole('button', { name: /Exécuter/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/suit la générale → 3650 jours/);
    expect(screen.queryByText(/Purge exécutée/)).not.toBeInTheDocument();
  });
});
