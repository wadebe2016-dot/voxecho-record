import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ANNUAIRE_FILTRE_DEFAUT,
  ATTRIBUTS_DEFAUT,
  type ReglagesAnnuaireResponse,
  type ResultatTestAnnuaire,
  type UserSummary,
} from '@voxecho/shared';
import { OngletAnnuaire } from '../src/components/OngletAnnuaire';
import { ComptesPage } from '../src/pages/ComptesPage';
import { afficher, PROFIL_AUDITEUR, reponse, simulerApi } from './helpers';

const ADMIN = { ...PROFIL_AUDITEUR, id: 'u-admin', role: 'ADMIN' as const, instanceAdmin: true };
const GROUPE_ADMINS = 'CN=VoxEcho-Admins,OU=Groupes,DC=banque,DC=local';

const ANNUAIRE: ReglagesAnnuaireResponse = {
  reglages: {
    actif: true,
    url: 'ldaps://dc01.banque.local:636',
    startTls: false,
    verifierCertificat: true,
    acPem: null,
    baseDn: 'DC=banque,DC=local',
    bindDn: 'CN=svc-voxecho,OU=Services,DC=banque,DC=local',
    bindMotDePasse: '********',
    filtre: ANNUAIRE_FILTRE_DEFAUT,
    attributs: ATTRIBUTS_DEFAUT,
    regles: [{ groupeDn: GROUPE_ADMINS, role: 'ADMIN', tenantId: 't-1' }],
    synchro: { actif: true, intervalleHeures: 6 },
  },
  version: 2,
  updatedAt: '2026-09-05T10:00:00Z',
  updatedByEmail: 'instance@banque-meridienne.cm',
  locataires: [{ id: 't-1', nom: 'Banque Méridienne' }],
  derniereSynchro: null,
};

function afficherOnglet(
  donnees: ReglagesAnnuaireResponse = ANNUAIRE,
  routes: Record<string, (init?: RequestInit) => Response> = {},
) {
  const fetchSimule = simulerApi({
    '/api/administration/annuaire': (init) =>
      init?.method === 'PUT' ? reponse(200, donnees) : reponse(200, donnees),
    ...routes,
  });
  afficher(<OngletAnnuaire />, ADMIN);
  return fetchSimule;
}

/**
 * Onglet Annuaire — CLAUDE.md §9.37.
 *
 * L'écran décide qui entre et avec quel rôle. Deux choses doivent s'y voir
 * sans effort : que le mot de passe de liaison ne se lit pas, et qu'une règle
 * absente ferme la porte plutôt que de l'ouvrir en grand.
 */
describe('onglet Annuaire', () => {
  it('ne montre jamais le mot de passe, et ne l’envoie que si on le remplace', async () => {
    const fetchSimule = afficherOnglet();

    expect(await screen.findByText('********')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Mot de passe de liaison/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    const envoi = fetchSimule.mock.calls.find((a) => (a[1] as RequestInit)?.method === 'PUT');
    const corps = JSON.parse(String((envoi?.[1] as RequestInit).body));
    // Un champ pré-rempli d'un masque finirait renvoyé tel quel, et le masque
    // deviendrait le secret.
    expect(corps.bindMotDePasse).toBeUndefined();
    expect(corps.reglages.bindMotDePasse).toBeUndefined();
    expect(corps.version).toBe(2);
  });

  it('envoie le nouveau secret quand on choisit de le remplacer', async () => {
    const fetchSimule = afficherOnglet();

    await userEvent.click(await screen.findByRole('button', { name: 'Remplacer' }));
    await userEvent.type(screen.getByLabelText(/Mot de passe de liaison/), 'Liaison-2026!');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    const envoi = fetchSimule.mock.calls.find((a) => (a[1] as RequestInit)?.method === 'PUT');
    expect(JSON.parse(String((envoi?.[1] as RequestInit).body)).bindMotDePasse).toBe(
      'Liaison-2026!',
    );
  });

  it('avertit quand la validation du certificat est désactivée', async () => {
    afficherOnglet({
      ...ANNUAIRE,
      reglages: { ...ANNUAIRE.reglages, verifierCertificat: false },
    });

    expect(await screen.findByText(/se ferait passer pour l’annuaire/)).toBeInTheDocument();
  });

  it('dit que sans règle, personne ne se connecte', async () => {
    afficherOnglet({ ...ANNUAIRE, reglages: { ...ANNUAIRE.reglages, regles: [] } });

    expect(
      await screen.findByText(/Aucune règle : personne ne peut se connecter par l’annuaire/),
    ).toBeInTheDocument();
  });

  it('présente une règle avec son groupe, son rôle et son locataire', async () => {
    afficherOnglet();

    expect(await screen.findByLabelText('Groupe 1')).toHaveValue(GROUPE_ADMINS);
    expect(screen.getByLabelText('Rôle 1')).toHaveValue('ADMIN');
    expect(screen.getByLabelText('Locataire 1')).toHaveValue('t-1');
  });

  it('rend les groupes vus et le rôle qui en découlerait', async () => {
    const resultat: ResultatTestAnnuaire = {
      bind: { reussi: true, message: 'Liaison au compte de service réussie.' },
      recherche: {
        tentee: true,
        trouve: true,
        message: 'Compte trouvé.',
        dn: 'CN=nkolo,OU=Utilisateurs,DC=banque,DC=local',
        login: 'nkolo',
        email: 'nkolo@banque.local',
        nomAffiche: 'Paul Nkolo',
        groupes: [GROUPE_ADMINS],
      },
      correspondance: { role: 'ADMIN', tenantId: 't-1', groupeDn: GROUPE_ADMINS },
    };
    afficherOnglet(ANNUAIRE, {
      '/api/administration/annuaire/test': () => reponse(201, resultat),
    });

    await userEvent.type(await screen.findByLabelText(/Identifiant à chercher/), 'nkolo');
    await userEvent.click(screen.getByRole('button', { name: 'Tester' }));

    const bloc = await screen.findByTestId('resultat-test-annuaire');
    expect(bloc).toHaveTextContent(/Liaison au compte de service réussie/);
    expect(bloc).toHaveTextContent(/Paul Nkolo/);
    expect(within(bloc).getByText(GROUPE_ADMINS)).toBeInTheDocument();
    expect(bloc).toHaveTextContent(/se connecterait comme Administrateur/);
  });

  it('dit qu’un utilisateur sans groupe mappé ne pourrait pas se connecter', async () => {
    const resultat: ResultatTestAnnuaire = {
      bind: { reussi: true, message: 'Liaison réussie.' },
      recherche: {
        tentee: true,
        trouve: true,
        message: 'Compte trouvé.',
        dn: 'CN=stagiaire,DC=banque,DC=local',
        login: 'stagiaire',
        email: null,
        nomAffiche: null,
        groupes: ['CN=Domain Users,DC=banque,DC=local'],
      },
      correspondance: null,
    };
    afficherOnglet(ANNUAIRE, {
      '/api/administration/annuaire/test': () => reponse(201, resultat),
    });

    await userEvent.type(await screen.findByLabelText(/Identifiant à chercher/), 'stagiaire');
    await userEvent.click(screen.getByRole('button', { name: 'Tester' }));

    expect(await screen.findByText(/ne pourrait pas se connecter/)).toBeInTheDocument();
  });

  it('remonte l’échec d’une liaison sans prétendre qu’elle a réussi', async () => {
    const resultat: ResultatTestAnnuaire = {
      bind: { reussi: false, message: 'Annuaire injoignable : connexion refusée' },
      recherche: null,
      correspondance: null,
    };
    afficherOnglet(ANNUAIRE, {
      '/api/administration/annuaire/test': () => reponse(201, resultat),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Tester' }));
    expect(await screen.findByText(/Annuaire injoignable/)).toBeInTheDocument();
  });
});

const compte = (reste: Partial<UserSummary>): UserSummary => ({
  id: 'u-1',
  email: 'auditeur@banque-meridienne.cm',
  role: 'AUDITOR',
  active: true,
  instanceAdmin: false,
  mustChangePassword: false,
  source: 'local',
  lastLoginAt: null,
  lockedUntil: null,
  createdAt: '2026-09-01T08:00:00Z',
  ...reste,
});

/** Écran Comptes, ce que l'annuaire y change — CLAUDE.md §9.37. */
describe('comptes et annuaire', () => {
  it('distingue un compte local d’un compte d’annuaire', async () => {
    simulerApi({
      '/api/users': () => reponse(200, [compte({}), compte({ id: 'u-2', email: 'ad@b.cm', source: 'ad' })]),
    });
    afficher(<ComptesPage />, ADMIN);

    expect(await screen.findByText('local')).toBeInTheDocument();
    expect(screen.getByText('annuaire')).toBeInTheDocument();
  });

  it('n’offre ni réinitialisation ni rattachement à un compte d’annuaire', async () => {
    // Il n'a pas de mot de passe local : il n'y a rien à réinitialiser, et il
    // est déjà rattaché.
    simulerApi({ '/api/users': () => reponse(200, [compte({ source: 'ad' })]) });
    afficher(<ComptesPage />, ADMIN);

    await screen.findByText('annuaire');
    expect(screen.queryByRole('button', { name: 'Réinitialiser' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Rattacher à l’annuaire' }),
    ).not.toBeInTheDocument();
  });

  it('rattache un compte local, et demande d’assumer quand il n’en resterait qu’un', async () => {
    const refus =
      'Il ne restera qu’un seul administrateur local après cette opération. Confirmez explicitement : le fait sera consigné au journal.';
    let assume = false;
    const fetchSimule = simulerApi({
      '/api/users': () => reponse(200, [compte({ role: 'ADMIN' })]),
      '/api/users/u-1/rattacher-annuaire': (init) => {
        assume = JSON.parse(String(init?.body)).acceptSansContreValidation === true;
        return assume ? reponse(200, compte({ source: 'ad' })) : reponse(400, { message: refus });
      },
    });
    vi.stubGlobal('confirm', vi.fn(() => true));
    afficher(<ComptesPage />, ADMIN);

    await userEvent.click(
      await screen.findByRole('button', { name: 'Rattacher à l’annuaire' }),
    );

    // Le refus n'est pas un échec : il demande d'assumer, et le dit.
    expect(assume).toBe(true);
    expect(fetchSimule).toHaveBeenCalled();
  });

  it('n’insiste pas quand l’administrateur refuse d’assumer', async () => {
    const refus = 'Il ne restera qu’un seul administrateur local après cette opération.';
    simulerApi({
      '/api/users': () => reponse(200, [compte({ role: 'ADMIN' })]),
      '/api/users/u-1/rattacher-annuaire': () => reponse(400, { message: refus }),
    });
    vi.stubGlobal('confirm', vi.fn(() => false));
    afficher(<ComptesPage />, ADMIN);

    await userEvent.click(
      await screen.findByRole('button', { name: 'Rattacher à l’annuaire' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/un seul administrateur local/);
  });
});
