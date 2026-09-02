import { describe, expect, it } from 'vitest';
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
  sha256: 'a'.repeat(64),
  sizeBytes: 2_928_000,
  source: 'simulator',
  status: 'stored',
  underHold: false,
};

const page = (items: RecordingListItem[]) =>
  reponse(200, { items, total: items.length, page: 1, pageSize: 25, pageCount: items.length });

/** Paramètres de la dernière requête envoyée à l'api. */
function derniereRequete(appels: { mock: { calls: unknown[][] } }): URLSearchParams {
  const dernier = appels.mock.calls.at(-1);
  return new URL(String(dernier?.[0]), 'http://localhost').searchParams;
}

describe('recherche d’enregistrements', () => {
  it('présente les critères du §6 en français', async () => {
    simulerApi({ '/api/recordings': () => page([APPEL]) });
    afficher(<RecordingsPage />);

    await screen.findByRole('form', { name: 'Recherche d’enregistrements' });
    expect(screen.getByLabelText('Numéro (poste ou correspondant)')).toBeInTheDocument();
    expect(screen.getByLabelText('Du')).toBeInTheDocument();
    expect(screen.getByLabelText('Au')).toBeInTheDocument();
    expect(screen.getByLabelText('Sens')).toBeInTheDocument();
    expect(screen.getByLabelText('Durée min (s)')).toBeInTheDocument();
    expect(screen.getByLabelText('Durée max (s)')).toBeInTheDocument();
  });

  it('ne cherche qu’à la validation, pas à chaque frappe', async () => {
    const fetch = simulerApi({ '/api/recordings': () => page([APPEL]) });
    afficher(<RecordingsPage />);
    await screen.findByText('01/09/2026 14:30:12');

    const appelsAuChargement = fetch.mock.calls.length;
    await userEvent.type(screen.getByLabelText('Numéro (poste ou correspondant)'), '699112233');

    // Neuf caractères saisis : le journal d'audit ne doit pas recevoir neuf
    // recherches que personne n'a demandées.
    expect(fetch.mock.calls.length).toBe(appelsAuChargement);
  });

  it('envoie les critères saisis à l’api', async () => {
    const fetch = simulerApi({ '/api/recordings': () => page([APPEL]) });
    afficher(<RecordingsPage />);
    await screen.findByText('01/09/2026 14:30:12');

    await userEvent.type(screen.getByLabelText('Numéro (poste ou correspondant)'), '699112233');
    await userEvent.selectOptions(screen.getByLabelText('Sens'), 'inbound');
    await userEvent.type(screen.getByLabelText('Durée min (s)'), '60');
    await userEvent.click(screen.getByRole('button', { name: 'Rechercher' }));

    await waitFor(() => {
      const params = derniereRequete(fetch);
      expect(params.get('phone')).toBe('699112233');
      expect(params.get('direction')).toBe('inbound');
      expect(params.get('minDurationSec')).toBe('60');
    });
  });

  it('n’envoie pas les champs laissés vides', async () => {
    const fetch = simulerApi({ '/api/recordings': () => page([APPEL]) });
    afficher(<RecordingsPage />);
    await screen.findByText('01/09/2026 14:30:12');

    await userEvent.type(screen.getByLabelText('Numéro (poste ou correspondant)'), '1001');
    await userEvent.click(screen.getByRole('button', { name: 'Rechercher' }));

    await waitFor(() => {
      const params = derniereRequete(fetch);
      expect(params.get('phone')).toBe('1001');
      expect(params.has('from')).toBe(false);
      expect(params.has('direction')).toBe(false);
      expect(params.has('maxDurationSec')).toBe(false);
    });
  });

  it('repart de la première page à chaque nouvelle recherche', async () => {
    const fetch = simulerApi({
      '/api/recordings': () =>
        reponse(200, { items: [APPEL], total: 60, page: 1, pageSize: 25, pageCount: 3 }),
    });
    afficher(<RecordingsPage />);
    await screen.findByText('01/09/2026 14:30:12');

    await userEvent.click(screen.getByRole('button', { name: 'Suivante' }));
    await waitFor(() => expect(derniereRequete(fetch).get('page')).toBe('2'));

    await userEvent.type(screen.getByLabelText('Numéro (poste ou correspondant)'), '1001');
    await userEvent.click(screen.getByRole('button', { name: 'Rechercher' }));

    await waitFor(() => expect(derniereRequete(fetch).get('page')).toBe('1'));
  });

  it('distingue « rien d’ingéré » de « rien qui corresponde »', async () => {
    simulerApi({ '/api/recordings': () => page([]) });
    afficher(<RecordingsPage />);

    expect(await screen.findByText('Aucun enregistrement')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Numéro (poste ou correspondant)'), '699000000');
    await userEvent.click(screen.getByRole('button', { name: 'Rechercher' }));

    expect(await screen.findByText('Aucun appel ne correspond')).toBeInTheDocument();
    expect(screen.getByText(/ne répond à ces critères/)).toBeInTheDocument();
  });

  it('propose de réinitialiser dès qu’un critère est saisi, et pas avant', async () => {
    simulerApi({ '/api/recordings': () => page([APPEL]) });
    afficher(<RecordingsPage />);
    await screen.findByText('01/09/2026 14:30:12');

    expect(screen.queryByRole('button', { name: 'Réinitialiser' })).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Numéro (poste ou correspondant)'), '1001');
    await userEvent.click(screen.getByRole('button', { name: 'Réinitialiser' }));

    expect(screen.getByLabelText('Numéro (poste ou correspondant)')).toHaveValue('');
  });

  it('remonte le refus du serveur sans vider la saisie', async () => {
    simulerApi({
      '/api/recordings': () =>
        reponse(400, { message: 'La date de début est postérieure à la date de fin.' }),
    });
    afficher(<RecordingsPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La date de début est postérieure à la date de fin.',
    );
  });
});
