import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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
    expect(screen.queryByRole('button', { name: /créer une politique/i })).toBeNull();
  });

  it('valide le brouillon avec le contrat partagé avant de l’envoyer', async () => {
    const faux = simulerApi({
      '/api/policies/en-vigueur': () => reponse(200, {}),
      '/api/policies': () => reponse(200, []),
      '/api/policies/brouillon': () => reponse(200, {}),
    });
    afficher(<PolitiquesPage />, profilPour('ADMIN'));

    await userEvent.click(await screen.findByRole('button', { name: /créer une politique/i }));
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

    await userEvent.click(await screen.findByRole('button', { name: /créer une politique/i }));
    const publier = screen.getByRole('button', { name: 'Publier' });

    // Renoncer d'avance à des preuves se motive : le bouton reste fermé tant
    // que la note ne dit rien.
    expect(publier).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/ce que cette version change/i), 'Exclusion des RH');
    await waitFor(() => expect(publier).toBeEnabled());
  });

  it('ouvre « Politiques » aux trois rôles, en lien direct', () => {
    simulerApi({});
    for (const role of ['ADMIN', 'SUPERVISOR', 'AUDITOR'] as const) {
      afficher(<AppShell>contenu</AppShell>, profilPour(role));
      const nav = screen.getAllByRole('navigation', { name: 'Navigation principale' })[0];
      expect(
        within(nav as HTMLElement).getByRole('link', { name: 'Politiques' }),
      ).toBeInTheDocument();
    }
  });

  it('ne présente aucun libellé de menu qu’on puisse confondre avec un autre', () => {
    // « Enregistrement » et « Enregistrements » se distinguaient d'une lettre
    // pour deux écrans sans rapport : les politiques et la liste des appels.
    simulerApi({});
    afficher(<AppShell>contenu</AppShell>, { ...profilPour('ADMIN'), instanceAdmin: true });

    const libelles = screen
      .getAllByRole('link')
      .map((lien) => (lien.textContent ?? '').trim().toLowerCase());

    // Aucun libellé ne doit être le préfixe d'un autre : c'est ce qui rendait
    // la paire précédente illisible d'un coup d'œil.
    for (const libelle of libelles) {
      const voisins = libelles.filter(
        (autre) => autre !== libelle && (autre.startsWith(libelle) || libelle.startsWith(autre)),
      );
      expect(voisins).toEqual([]);
    }
  });

  describe('simulateur de décision', () => {
    /** Politique publiée : RH exclue, marchés systématique, 20 % ailleurs. */
    const AVEC_REGLES: PolicyVersionDetail = {
      ...EN_VIGUEUR,
      document: {
        schema: 1,
        parDefaut: 'sample',
        tauxParDefautPourcent: 20,
        exclusions: ['1090'],
        motifExclusions: 'Ressources humaines et médecine du travail',
        listes: [{ nom: 'Salle des marchés', numeros: ['1001'] }],
        regles: [
          {
            libelle: 'Salle des marchés',
            critere: 'liste',
            valeur: 'Salle des marchés',
            decision: 'always',
            annonce: true,
            pauseAutorisee: true,
          },
        ],
      },
    };

    function ouvrir() {
      simulerApi({
        '/api/policies/en-vigueur': () => reponse(200, AVEC_REGLES),
        '/api/policies': () => reponse(200, [AVEC_REGLES]),
        '/api/policies/brouillon': () => reponse(200, {}),
      });
      return afficher(<PolitiquesPage />, profilPour('AUDITOR'));
    }

    it('explique pourquoi un appel serait enregistré, règle nommée à l’appui', async () => {
      ouvrir();
      const verdict = await screen.findByTestId('verdict-simulation');

      // Le poste 1001 est dans la liste « Salle des marchés » : la règle
      // l'emporte sur l'échantillonnage par défaut.
      expect(verdict).toHaveTextContent(/serait enregistré/i);
      expect(verdict).toHaveTextContent(/Salle des marchés/);
      expect(verdict).toHaveTextContent(/Annonce à l’appelant/);
    });

    it('fait primer une exclusion, et le dit avec son motif', async () => {
      ouvrir();
      await screen.findByTestId('verdict-simulation');

      await userEvent.clear(screen.getByLabelText('Poste'));
      await userEvent.type(screen.getByLabelText('Poste'), '1090');

      const verdict = screen.getByTestId('verdict-simulation');
      expect(verdict).toHaveTextContent(/ne serait pas enregistré/i);
      expect(verdict).toHaveTextContent(/Médecine du travail|médecine du travail/);
    });

    it('montre le tirage d’un échantillonnage et le dit rejouable', async () => {
      ouvrir();
      await screen.findByTestId('verdict-simulation');

      // Un poste hors de toute règle : c'est le défaut, à 20 %.
      await userEvent.clear(screen.getByLabelText('Poste'));
      await userEvent.type(screen.getByLabelText('Poste'), '1055');

      const verdict = screen.getByTestId('verdict-simulation');
      expect(verdict).toHaveTextContent(/échantillon 20 %, tirage \d+/);
      // Le caractère rejouable du tirage se lit à l'aide, plus en paragraphe.
      expect(screen.getByLabelText(/décision réelle, rejouée/i)).toBeInTheDocument();
    });
  });
});
