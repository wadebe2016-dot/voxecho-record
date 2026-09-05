import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RetentionPolicyEntry, RetentionPolicySetResponse } from '@voxecho/shared';
import { ConservationPage } from '../src/pages/ConservationPage';
import { afficher, profilPour, reponse, simulerApi } from './helpers';

const entree = (
  appliesTo: string,
  days: number,
  reste: Partial<RetentionPolicyEntry> = {},
): RetentionPolicyEntry => ({
  appliesTo,
  days,
  belowFloorReason: null,
  updatedAt: '2026-08-01T09:00:00Z',
  enregistree: true,
  plancherReglementaire: 0,
  ...reste,
});

const ENSEMBLE: RetentionPolicySetResponse = {
  generale: entree('all', 730),
  parCategorie: [
    entree('confirmation_cheque', 730, { enregistree: false }),
    entree('operation_change', 3650),
    entree('autre', 730, { enregistree: false }),
  ],
  minDays: 730,
};

function afficherEcran(
  ensemble: RetentionPolicySetResponse = ENSEMBLE,
  role: 'ADMIN' | 'SUPERVISOR' | 'AUDITOR' = 'ADMIN',
  routes: Record<string, (init?: RequestInit) => Response> = {},
) {
  const fetchSimule = simulerApi({
    '/api/retention/ensemble': () => reponse(200, ensemble),
    ...routes,
  });
  afficher(<ConservationPage />, profilPour(role));
  return fetchSimule;
}

/** La ligne d'un périmètre, telle qu'elle se lit à l'écran. */
function ligne(perimetre: string): Promise<HTMLElement> {
  return screen.findByTestId(`perimetre-${perimetre}`);
}

/**
 * Durées de conservation — CLAUDE.md §9.6, §9.28 et §9.30.
 *
 * Deux choses doivent se lire sans effort : d'où vient la durée qui s'applique
 * à une catégorie, et jusqu'où on peut descendre. Les deux planchers ne disent
 * pas la même chose — l'un se franchit avec un motif, l'autre pas — et l'écran
 * ne doit pas les confondre.
 */
describe('écran des durées de conservation', () => {
  it('distingue une durée décidée d’une durée héritée', async () => {
    afficherEcran({ ...ENSEMBLE, generale: entree('all', 730, { enregistree: false }) });

    // Sans cette distinction, on ne saurait pas si 730 jours résultent d'un
    // choix ou d'un défaut.
    expect(await screen.findByText(/héritée du défaut produit/)).toBeInTheDocument();
    expect(within(await ligne('operation_change')).getByText(/décidée le/)).toBeInTheDocument();
    expect(
      within(await ligne('confirmation_cheque')).getByText(/héritée de la durée générale/),
    ).toBeInTheDocument();
  });

  it('affiche la durée effective de chaque catégorie, héritée comprise', async () => {
    afficherEcran();

    expect(await screen.findByText('3650 jours')).toBeInTheDocument();
    // La catégorie sans politique propre n'affiche pas un vide : elle suit la
    // générale, et l'écran le dit.
    expect(within(await ligne('confirmation_cheque')).getByText(/730 jours/)).toBeInTheDocument();
  });

  it('présente les deux planchers en lecture seule, fixés par Atlastech', async () => {
    afficherEcran({
      ...ENSEMBLE,
      generale: entree('all', 730),
      parCategorie: [entree('operation_change', 3650, { plancherReglementaire: 3650 })],
    });

    const minimums = await screen.findByRole('region', { name: 'Minimums applicables' });
    expect(minimums).toHaveTextContent(/Plancher de l’instance/);
    expect(minimums).toHaveTextContent(/730 jours/);
    expect(minimums).toHaveTextContent(/Opération de change : 3650 j/);
    // Ce n'est pas un réglage client : aucun champ, et la mention le dit.
    expect(within(minimums).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(minimums).queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(within(minimums).getAllByText(/fixé par Atlastech/)).toHaveLength(2);
  });

  it('dit qu’aucun minimum réglementaire n’est déclaré plutôt que d’en inventer un', async () => {
    afficherEcran();

    const minimums = await screen.findByRole('region', { name: 'Minimums applicables' });
    expect(within(minimums).getByText('aucun déclaré')).toBeInTheDocument();
  });

  it('signale une politique dérogatoire et son motif', async () => {
    afficherEcran({
      ...ENSEMBLE,
      generale: entree('all', 365, { belowFloorReason: 'Décision du comité du 12 août 2026' }),
    });

    expect(await screen.findByText(/Politique dérogatoire/)).toBeInTheDocument();
    expect(screen.getByText(/Décision du comité du 12 août 2026/)).toBeInTheDocument();
  });

  it('ne demande un motif que sous le plancher de l’instance', async () => {
    afficherEcran();
    const champ = await screen.findByLabelText<HTMLInputElement>('Durée, en jours', {
      selector: '#duree-all',
    });

    // Au-dessus du plancher, aucun motif : faire justifier un allongement
    // transformerait la prudence en corvée (§9.6).
    expect(screen.queryByLabelText(/Motif de dérogation/)).not.toBeInTheDocument();

    await userEvent.clear(champ);
    await userEvent.type(champ, '365');
    expect(await screen.findByLabelText(/Motif de dérogation/)).toBeInTheDocument();
  });

  it('envoie le périmètre, la durée et le motif', async () => {
    const fetchSimule = afficherEcran(ENSEMBLE, 'ADMIN', {
      '/api/retention': () => reponse(200, {}),
    });

    const champ = await screen.findByLabelText<HTMLInputElement>('Durée, en jours', {
      selector: '#duree-operation_change',
    });
    await userEvent.clear(champ);
    await userEvent.type(champ, '1825');
    await userEvent.click(
      within(await ligne('operation_change')).getByRole('button', { name: 'Modifier' }),
    );

    const envoi = fetchSimule.mock.calls.find((appel) => String(appel[0]).endsWith('/retention'));
    expect(JSON.parse(String((envoi?.[1] as RequestInit).body))).toEqual({
      days: 1825,
      appliesTo: 'operation_change',
    });
  });

  it('laisse l’auditeur lire les durées sans les modifier', async () => {
    afficherEcran(ENSEMBLE, 'AUDITOR');

    expect(await screen.findByText('3650 jours')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Modifier' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Durée, en jours')).not.toBeInTheDocument();
  });

  it('remonte le refus de l’api sans prétendre avoir enregistré', async () => {
    afficherEcran(ENSEMBLE, 'ADMIN', {
      '/api/retention': () =>
        reponse(400, {
          message: 'Durée refusée : en dessous du minimum réglementaire de 3650 jours.',
        }),
    });

    await userEvent.click(
      within(await ligne('operation_change')).getByRole('button', { name: 'Modifier' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/minimum réglementaire de 3650/);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
