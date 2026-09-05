import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LegalHoldResponse, RecordingListItem } from '@voxecho/shared';
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
  operationCategory: 'autre',
  underHold: false,
};

const HOLD: LegalHoldResponse = {
  id: 'h-1',
  recordingId: 'r-1',
  reason: 'Réquisition judiciaire',
  caseReference: 'n° 2026-118 du parquet de Douala',
  setByEmail: 'admin@banque-meridienne.cm',
  at: '2026-08-30T09:00:00Z',
  releasedAt: null,
  releasedByEmail: null,
  releaseReason: null,
  releasedWithoutSecondApproval: false,
};

const liste = (appel: RecordingListItem) => () =>
  reponse(200, { items: [appel], total: 1, page: 1, pageSize: 25, pageCount: 1 });

/** Ouvre la fiche d'un appel, avec l'historique de conservation qu'on veut. */
async function ouvrirLaFiche(
  appel: RecordingListItem,
  routes: Record<string, (init?: RequestInit) => Response> = {},
  role: 'ADMIN' | 'SUPERVISOR' | 'AUDITOR' = 'ADMIN',
) {
  const fetchSimule = simulerApi({
    '/api/recordings': liste(appel),
    '/api/recordings/r-1/holds': () => reponse(200, []),
    ...routes,
  });
  afficher(<RecordingsPage />, profilPour(role));
  await userEvent.click(await screen.findByRole('button', { name: /Consulter l’appel/ }));
  return fetchSimule;
}

/**
 * Conservation forcée — CLAUDE.md §5, §9.6 et §9.29.
 *
 * Un hold soustrait un appel à la purge. C'est un état qui change ce que
 * l'appel devient : il doit se voir, avec son motif, son dossier et son
 * auteur, sinon un auditeur croit lire un appel ordinaire là où une mesure
 * court. Poser protège une preuve ; lever la rend destructible — les deux
 * actes ne se présentent donc pas de la même façon.
 */
describe('conservation forcée au portail', () => {
  it('marque l’appel dans la liste sans effacer son statut de fichier', async () => {
    simulerApi({ '/api/recordings': liste({ ...APPEL, underHold: true }) });
    afficher(<RecordingsPage />);

    expect(await screen.findByText('conservation forcée')).toBeInTheDocument();
    // Le statut du fichier reste lisible à côté : le hold ne s'y substitue
    // pas, c'est une mesure qui s'ajoute, pas un état de stockage.
    expect(screen.getByText('Conservé')).toBeInTheDocument();
  });

  it('ne signale aucune mesure sur un appel ordinaire', async () => {
    await ouvrirLaFiche(APPEL);

    expect(await screen.findByText(/Aucune conservation forcée en cours/)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('annonce la mesure sur la fiche, avec son motif, son dossier et son auteur', async () => {
    await ouvrirLaFiche(
      { ...APPEL, underHold: true },
      {
        '/api/recordings/r-1/holds': () => reponse(200, [HOLD]),
      },
    );

    const mesure = await screen.findByRole('status');
    expect(mesure).toHaveTextContent(/Sous conservation forcée/);
    expect(mesure).toHaveTextContent(/soustrait à la purge automatique/);
    expect(mesure).toHaveTextContent(/Réquisition judiciaire/);
    expect(mesure).toHaveTextContent(/n° 2026-118 du parquet de Douala/);
    expect(mesure).toHaveTextContent(/admin@banque-meridienne\.cm/);
    expect(mesure).toHaveTextContent(/30\/08\/2026/);
  });

  it('annonce la mesure même quand son détail ne se charge pas', async () => {
    // Sans ce garde, une fiche dont l'historique échoue se lirait comme un
    // appel ordinaire : le portail dirait moins que ce qu'il sait.
    await ouvrirLaFiche(
      { ...APPEL, underHold: true },
      {
        '/api/recordings/r-1/holds': () => reponse(500, { message: 'indisponible' }),
      },
    );

    const mesure = await screen.findByRole('status');
    expect(mesure).toHaveTextContent(/Sous conservation forcée/);
    expect(mesure).toHaveTextContent(/n’a pas pu être chargé/);
  });

  it('exige un motif et une référence de dossier pour poser', async () => {
    await ouvrirLaFiche(APPEL);

    await userEvent.click(await screen.findByRole('button', { name: 'Poser une conservation' }));
    const poser = screen.getByRole('button', { name: 'Poser' });
    expect(poser).toBeDisabled();

    await userEvent.type(screen.getByLabelText('Motif'), 'Réquisition judiciaire');
    // Le motif seul ne suffit pas : « réquisition judiciaire » dit ce qu'on
    // fait, la référence dit de quoi on parle (§9.29).
    expect(poser).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/Référence du dossier/), 'n° 2026-118');
    expect(poser).toBeEnabled();
  });

  it('transmet le motif et le dossier à la pose', async () => {
    const fetchSimule = await ouvrirLaFiche(APPEL, {
      '/api/recordings/r-1/holds': (init) =>
        init?.method === 'POST' ? reponse(201, HOLD) : reponse(200, []),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Poser une conservation' }));
    await userEvent.type(screen.getByLabelText('Motif'), 'Réquisition judiciaire');
    await userEvent.type(screen.getByLabelText(/Référence du dossier/), 'n° 2026-118');
    await userEvent.click(screen.getByRole('button', { name: 'Poser' }));

    const pose = fetchSimule.mock.calls.find(
      (appel) =>
        String(appel[0]).includes('/holds') && (appel[1] as RequestInit)?.method === 'POST',
    );
    expect(JSON.parse(String((pose?.[1] as RequestInit).body))).toEqual({
      reason: 'Réquisition judiciaire',
      caseReference: 'n° 2026-118',
    });
  });

  it('propose d’assumer la levée quand l’api la refuse faute d’un second administrateur', async () => {
    const refus =
      'Aucun autre administrateur actif : la levée est possible sans contre-validation, mais elle doit être acceptée explicitement et sera consignée comme telle.';
    let assume = false;

    const fetchSimule = await ouvrirLaFiche(
      { ...APPEL, underHold: true },
      {
        '/api/recordings/r-1/holds': () => reponse(200, [HOLD]),
        '/api/recordings/r-1/holds/release': (init) => {
          assume = JSON.parse(String(init?.body)).acceptSansContreValidation === true;
          return assume ? reponse(200, HOLD) : reponse(400, { message: refus });
        },
      },
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Lever la conservation' }));
    await userEvent.type(screen.getByLabelText('Motif'), 'Dossier clos par le parquet');
    await userEvent.click(screen.getByRole('button', { name: 'Lever' }));

    // Le refus n'est pas un échec : il demande d'assumer, et le dit.
    expect(await screen.findByRole('alert')).toHaveTextContent(/acceptée explicitement/);
    const bouton = await screen.findByRole('button', { name: 'Lever sans contre-validation' });
    expect(screen.getByText(/consignée comme faite sans contre-validation/)).toBeInTheDocument();

    await userEvent.click(bouton);
    expect(assume).toBe(true);
    expect(fetchSimule).toHaveBeenCalled();
  });

  it('n’offre pas de poser ni de lever à un auditeur', async () => {
    // Il constate, il n'ordonne pas (§9.29) : l'historique lui reste ouvert.
    await ouvrirLaFiche(
      { ...APPEL, underHold: true },
      {
        '/api/recordings/r-1/holds': () => reponse(200, [HOLD]),
      },
      'AUDITOR',
    );

    expect(await screen.findByRole('status')).toHaveTextContent(/Réquisition judiciaire/);
    expect(screen.queryByRole('button', { name: /Lever/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Poser/ })).not.toBeInTheDocument();
  });

  it('conserve la trace des conservations levées, et dit celles qui l’ont été seul', async () => {
    const levee: LegalHoldResponse = {
      ...HOLD,
      id: 'h-0',
      releasedAt: '2026-08-31T10:00:00Z',
      releasedByEmail: 'admin@banque-meridienne.cm',
      releaseReason: 'Dossier clos',
      releasedWithoutSecondApproval: true,
    };
    await ouvrirLaFiche(APPEL, {
      '/api/recordings/r-1/holds': () => reponse(200, [levee]),
    });

    const historique = await screen.findByText(/Conservations levées \(1\)/);
    await userEvent.click(historique);
    const bloc = historique.closest('details') as HTMLElement;
    expect(within(bloc).getByText(/Levée sans contre-validation/)).toBeInTheDocument();
    expect(within(bloc).getByText(/Dossier clos/)).toBeInTheDocument();
  });
});
