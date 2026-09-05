import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EtatHorloge, ReglagesReseauResponse } from '@voxecho/shared';
import { AdministrationPage } from '../src/pages/AdministrationPage';
import { AppShell } from '../src/components/AppShell';
import { afficher, PROFIL_AUDITEUR, profilPour, reponse, simulerApi } from './helpers';

const HORLOGE: EtatHorloge = {
  statut: 'synchronise',
  source: '196.1.2.3',
  decalageMs: 42,
  stratum: 2,
  derniereSynchro: '2026-09-05T18:00:00Z',
  releveLe: '2026-09-05T18:00:30Z',
  message: 'Synchronisée sur 196.1.2.3, décalage de 42 ms.',
};

const RESEAU: ReglagesReseauResponse = {
  reglages: {
    fuseau: 'Africa/Douala',
    ntp: { serveurs: [], applique: false },
    dns: { primaire: null, secondaire: null, domaineRecherche: null, applique: false },
    proxys: { cidr: [] },
  },
  version: 3,
  mode: 'cloud',
  etatHorloge: HORLOGE,
  proxysEnVigueur: { valeurs: [], source: 'base' },
  updatedAt: '2026-09-04T10:00:00Z',
  updatedByEmail: 'instance@banque-meridienne.cm',
};

const REGLAGES_GENERAUX = {
  version: '0.1.0',
  evaluation: true,
  groupes: [],
  locataires: [],
};

const ADMIN_INSTANCE = { ...PROFIL_AUDITEUR, role: 'ADMIN' as const, instanceAdmin: true };

async function ouvrirOngletReseau(
  reseau: ReglagesReseauResponse = RESEAU,
  routes: Record<string, (init?: RequestInit) => Response> = {},
) {
  const fetchSimule = simulerApi({
    '/api/administration/reglages': () => reponse(200, REGLAGES_GENERAUX),
    '/api/administration/reseau': () => reponse(200, reseau),
    '/api/administration/reseau/horloge': () => reponse(200, reseau.etatHorloge),
    ...routes,
  });
  afficher(<AdministrationPage />, ADMIN_INSTANCE);
  await userEvent.click(await screen.findByRole('tab', { name: 'Réseau' }));
  return fetchSimule;
}

/**
 * Onglet Réseau — CLAUDE.md §9.36.
 *
 * Ce qui s'y joue : une horloge dont l'état conditionne la valeur probante de
 * tout le reste, et des champs dont certains n'ont aucun effet — l'écran doit
 * le dire, faute de quoi un administrateur croira avoir réglé ce qu'il n'a pas
 * réglé.
 */
describe('onglet Réseau', () => {
  it('présente l’état de l’horloge en lecture seule, avec son relevé', async () => {
    await ouvrirOngletReseau();

    expect(await screen.findByText(/État de l’horloge : Synchronisée/)).toBeInTheDocument();
    expect(screen.getByText('196.1.2.3')).toBeInTheDocument();
    expect(screen.getByText('42 ms')).toBeInTheDocument();
  });

  it('masque les sections d’un boîtier en nuage, et dit qui rend le service', async () => {
    // Un vide se lirait comme une panne ; la ligne dit qui tient l'heure et les
    // noms à la place du produit (§9.36).
    await ouvrirOngletReseau();

    expect(await screen.findByText(/Amazon Time Sync/)).toBeInTheDocument();
    expect(screen.getByText(/Résolveur fourni par AWS/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Serveur 1')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Résolveur primaire')).not.toBeInTheDocument();
  });

  it('ouvre les sections d’un boîtier installé, en annonçant qu’elles ne s’appliquent pas', async () => {
    await ouvrirOngletReseau({ ...RESEAU, mode: 'onprem' });

    expect(await screen.findByLabelText('Serveur 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Résolveur primaire')).toBeInTheDocument();
    expect(screen.getAllByText(/Configuré à l’installation du boîtier/).length).toBeGreaterThan(0);
  });

  it('envoie la version lue avec la modification', async () => {
    const fetchSimule = await ouvrirOngletReseau(RESEAU, {
      '/api/administration/reseau': (init) =>
        init?.method === 'PUT' ? reponse(200, { ...RESEAU, version: 4 }) : reponse(200, RESEAU),
    });

    const fuseau = await screen.findByLabelText(/Fuseau d’affichage/);
    await userEvent.clear(fuseau);
    await userEvent.type(fuseau, 'Europe/Paris');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    const envoi = fetchSimule.mock.calls.find(
      (appel) => (appel[1] as RequestInit)?.method === 'PUT',
    );
    const corps = JSON.parse(String((envoi?.[1] as RequestInit).body));
    // Sans la version lue, deux administrateurs s'écraseraient sans le savoir.
    expect(corps.version).toBe(3);
    expect(corps.reglages.fuseau).toBe('Europe/Paris');
  });

  it('remonte le refus d’une version périmée sans prétendre avoir enregistré', async () => {
    await ouvrirOngletReseau(RESEAU, {
      '/api/administration/reseau': (init) =>
        init?.method === 'PUT'
          ? reponse(409, { message: 'Ce réglage a été modifié depuis son ouverture.' })
          : reponse(200, RESEAU),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Enregistrer' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/modifié depuis son ouverture/);
    expect(screen.queryByText(/Réglages enregistrés/)).not.toBeInTheDocument();
  });

  it('dit que la valeur saisie pour les relais ne s’applique pas quand l’environnement gagne', async () => {
    await ouvrirOngletReseau({
      ...RESEAU,
      proxysEnVigueur: { valeurs: ['172.20.0.0/16'], source: 'environnement' },
    });

    const section = await screen.findByRole('region', { name: /Relais de confiance/ });
    expect(section).toHaveTextContent(/En vigueur : la variable d’environnement/);
    expect(section).toHaveTextContent(/ne s’applique pas/);
  });

  it('dit qu’aucun relais n’est déclaré plutôt que de laisser un vide', async () => {
    await ouvrirOngletReseau();

    const section = await screen.findByRole('region', { name: /Relais de confiance/ });
    expect(section).toHaveTextContent(/Aucun relais déclaré/);
  });

  it('rend le résultat d’un test de résolution, même quand il n’y a rien à résoudre', async () => {
    await ouvrirOngletReseau({ ...RESEAU, mode: 'onprem' }, {
      '/api/administration/reseau/test/dns': () => reponse(201, []),
    });

    await userEvent.click(await screen.findByRole('button', { name: 'Tester la résolution' }));

    // Annoncer un test réussi qui n'aurait rien testé serait pire que rien.
    expect(await screen.findByText(/ni annuaire ni serveur de courriel/)).toBeInTheDocument();
  });
});

/**
 * Bandeau d'horodatage non fiable — CLAUDE.md §9.36.
 *
 * Il s'affiche en tête de toute la console, et pour les trois rôles : un
 * auditeur qui relève une empreinte doit savoir que l'heure inscrite à côté
 * n'est peut-être pas défendable.
 */
describe('bandeau d’horodatage', () => {
  const horloge = (statut: EtatHorloge['statut'], message = 'x') => () =>
    reponse(200, { ...HORLOGE, statut, message });

  it('ne s’affiche pas quand l’horloge suit', async () => {
    simulerApi({ '/api/administration/reseau/horloge': horloge('synchronise') });
    afficher(<AppShell>contenu</AppShell>, PROFIL_AUDITEUR);

    await waitFor(() => expect(screen.getByText('contenu')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('s’affiche pour un auditeur quand l’horloge ne suit plus', async () => {
    simulerApi({
      '/api/administration/reseau/horloge': horloge(
        'non_synchronise',
        'Le service de temps n’est synchronisé sur aucune source.',
      ),
    });
    afficher(<AppShell>contenu</AppShell>, PROFIL_AUDITEUR);

    const bandeau = await screen.findByRole('alert');
    expect(bandeau).toHaveTextContent(/Horodatage non fiable/);
    expect(bandeau).toHaveTextContent(/valeur probante des enregistrements n’est pas garantie/);
    expect(bandeau).toHaveTextContent(/synchronisé sur aucune source/);
  });

  it('ne crie pas quand on n’a simplement pas su lire l’horloge', async () => {
    // « indisponible » n'est pas « non synchronisé » : un bandeau qui crierait
    // parce qu'un relevé manque userait l'avertissement jusqu'à ce que plus
    // personne ne le lise. L'écran d'état s'en charge, en orange.
    simulerApi({ '/api/administration/reseau/horloge': horloge('indisponible') });
    afficher(<AppShell>contenu</AppShell>, PROFIL_AUDITEUR);

    await waitFor(() => expect(screen.getByText('contenu')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('ne transforme pas une api injoignable en alerte d’horodatage', async () => {
    simulerApi({});
    afficher(<AppShell>contenu</AppShell>, PROFIL_AUDITEUR);

    await waitFor(() => expect(screen.getByText('contenu')).toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

/** L'onglet Réseau ne s'ouvre qu'à l'administrateur d'instance (§9.22). */
describe('habilitation des réglages d’instance', () => {
  it('ne montre aucun onglet à qui n’administre pas l’instance', async () => {
    simulerApi({});
    afficher(<AdministrationPage />, profilPour('ADMIN'));

    expect(await screen.findByText(/Réservé aux administrateurs de l’instance/)).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Réseau' })).not.toBeInTheDocument();
  });

  it('présente les deux onglets à l’administrateur d’instance', async () => {
    simulerApi({
      '/api/administration/reglages': () => reponse(200, REGLAGES_GENERAUX),
      '/api/administration/reseau': () => reponse(200, RESEAU),
      '/api/administration/reseau/horloge': () => reponse(200, HORLOGE),
    });
    afficher(<AdministrationPage />, ADMIN_INSTANCE);

    const onglets = await screen.findAllByRole('tab');
    expect(onglets.map((o) => o.textContent)).toEqual(['Général', 'Réseau']);
    expect(within(onglets[0] as HTMLElement).queryByText('Général')).toBeDefined();
  });
});
