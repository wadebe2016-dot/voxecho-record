import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PolicyVersionDetail } from '@voxecho/shared';
import { PolitiquesPage } from '../src/pages/PolitiquesPage';
import { AppShell } from '../src/components/AppShell';
import { afficher, PROFIL_AUDITEUR, profilPour, reponse, simulerApi } from './helpers';

const EN_VIGUEUR: PolicyVersionDetail = {
  id: 'p-1',
  version: 3,
  status: 'published',
  note: 'Marchés systématique, RH exclue, 20 % ailleurs',
  sha256: 'a'.repeat(64),
  createdByEmail: 'admin@demo.cm',
  createdAt: '2026-09-01T09:00:00.000Z',
  publishedByEmail: 'admin@demo.cm',
  publishedAt: '2026-09-01T09:05:00.000Z',
  resume: { parDefaut: 'sample', regles: 2, exclusions: 3, listes: 1 },
  document: {
    schema: 1,
    parDefaut: 'sample',
    tauxParDefautPourcent: 20,
    exclusions: ['1090'],
    motifExclusions: 'Ressources humaines',
    listes: [],
    regles: [],
  },
};

/**
 * Écrans de politique d'enregistrement — CLAUDE.md §9.23.
 *
 * Ce que ces cas protègent : l'écran doit dire ce qui s'applique, ce qui se
 * prépare et ce qui s'est appliqué avant — et ne jamais laisser croire qu'un
 * brouillon agit sur la capture.
 */
describe('politiques d’enregistrement', () => {
  it('dit que tout est enregistré tant qu’aucune politique n’est publiée', async () => {
    simulerApi({
      '/api/policies/en-vigueur': () => reponse(200, {}),
      '/api/policies': () => reponse(200, []),
      '/api/policies/brouillon': () => reponse(200, {}),
    });
    afficher(<PolitiquesPage />, profilPour('ADMIN'));

    // Ne pas enregistrer doit résulter d'une décision : en l'absence de
    // politique, l'écran doit le dire clairement plutôt que d'afficher un vide.
    expect(await screen.findByText(/tous les appels sont enregistrés/i)).toBeInTheDocument();
  });

  it('affiche la version en vigueur, sa note et son empreinte', async () => {
    simulerApi({
      '/api/policies/en-vigueur': () => reponse(200, EN_VIGUEUR),
      '/api/policies': () => reponse(200, [EN_VIGUEUR]),
      '/api/policies/brouillon': () => reponse(200, {}),
    });
    afficher(<PolitiquesPage />, profilPour('AUDITOR'));

    expect(await screen.findByText(/Version 3/)).toBeInTheDocument();
    // La note paraît deux fois — en vigueur et dans l'historique — et c'est
    // voulu : on lit ce qui s'applique sans faire défiler jusqu'au tableau.
    expect(screen.getAllByText(/Marchés systématique/)).toHaveLength(2);
    expect(screen.getByText(new RegExp('a'.repeat(20)))).toBeInTheDocument();
  });

  it('n’offre aucune édition à qui ne peut pas changer la politique', async () => {
    simulerApi({
      '/api/policies/en-vigueur': () => reponse(200, EN_VIGUEUR),
      '/api/policies': () => reponse(200, [EN_VIGUEUR]),
    });
    afficher(<PolitiquesPage />, PROFIL_AUDITEUR);

    await screen.findByText(/Version 3/);
    // Un auditeur lit la politique — c'est une question de conformité — mais
    // ne la change pas (§9.23).
    expect(screen.queryByRole('button', { name: /publier/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /commencer une politique/i })).toBeNull();
  });

  it('valide le brouillon avec le contrat partagé avant de l’envoyer', async () => {
    const faux = simulerApi({
      '/api/policies/en-vigueur': () => reponse(200, {}),
      '/api/policies': () => reponse(200, []),
      '/api/policies/brouillon': () => reponse(200, {}),
    });
    afficher(<PolitiquesPage />, profilPour('ADMIN'));

    await userEvent.click(await screen.findByRole('button', { name: /commencer une politique/i }));
    // Un échantillonnage sans taux : le contrat le refuse, et l'écran le dit
    // sans aller déranger l'api — c'est le même validateur des deux côtés.
    await userEvent.selectOptions(screen.getByLabelText('Décision par défaut'), 'sample');
    await userEvent.clear(screen.getByLabelText('Taux (%)'));
    await userEvent.click(screen.getByRole('button', { name: /enregistrer le brouillon/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/échantillonnage sans taux/i);
    expect(
      faux.mock.calls.filter(([url]) => String(url).includes('/policies/brouillon')).length,
    ).toBe(1);
  });

  it('exige une note avant d’autoriser la publication', async () => {
    simulerApi({
      '/api/policies/en-vigueur': () => reponse(200, {}),
      '/api/policies': () => reponse(200, []),
      '/api/policies/brouillon': () => reponse(200, {}),
    });
    afficher(<PolitiquesPage />, profilPour('ADMIN'));

    await userEvent.click(await screen.findByRole('button', { name: /commencer une politique/i }));
    const publier = screen.getByRole('button', { name: 'Publier' });

    // Renoncer d'avance à des preuves se motive : le bouton reste fermé tant
    // que la note ne dit rien.
    expect(publier).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/ce que cette version change/i), 'Exclusion des RH');
    await waitFor(() => expect(publier).toBeEnabled());
  });

  it('ouvre l’entrée de navigation aux trois rôles', () => {
    simulerApi({});
    for (const role of ['ADMIN', 'SUPERVISOR', 'AUDITOR'] as const) {
      afficher(<AppShell>contenu</AppShell>, profilPour(role));
      expect(screen.getAllByRole('link', { name: 'Enregistrement' }).length).toBeGreaterThan(0);
    }
  });
});
