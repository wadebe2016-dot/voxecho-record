import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import type { InstanceSettingsResponse, ProfileResponse } from '@voxecho/shared';
import { AdministrationPage } from '../src/pages/AdministrationPage';
import { AppShell } from '../src/components/AppShell';
import { afficher, PROFIL_AUDITEUR, profilPour, reponse, simulerApi } from './helpers';

const REGLAGES: InstanceSettingsResponse = {
  version: '0.1.0',
  evaluation: true,
  groupes: [
    {
      titre: 'Accès et sessions',
      reglages: [
        {
          cle: 'TRUSTED_PROXIES',
          valeur: '172.16.0.0/12',
          effet: 'Relais dont l’en-tête X-Forwarded-For est cru.',
          raisonLectureSeule: 'Un compte compromis se rendrait invisible du journal.',
        },
      ],
    },
  ],
  locataires: [
    {
      id: 't-1',
      nom: 'Banque Méridienne',
      slug: 'banque-meridienne',
      actif: true,
      comptes: 3,
      enregistrements: 42,
    },
  ],
};

/** Profil d'un administrateur de l'instance. */
const ADMIN_INSTANCE: ProfileResponse = { ...profilPour('ADMIN'), instanceAdmin: true };

/**
 * Console d'administration — CLAUDE.md §9.22.
 *
 * Le masquage n'est qu'un confort d'affichage : c'est l'api qui refuse. Mais
 * un confort mal réglé fait chercher une panne là où il y a une habilitation,
 * et c'est précisément ce que le §9.9 demande d'éviter.
 */
describe('console d’administration', () => {
  it('n’ouvre l’entrée de navigation qu’à l’administrateur de l’instance', () => {
    simulerApi({});

    afficher(<AppShell>contenu</AppShell>, ADMIN_INSTANCE);
    expect(screen.getByRole('link', { name: 'Administration' })).toBeInTheDocument();
  });

  it('ne la montre pas à un ADMIN qui n’administre que son locataire', () => {
    simulerApi({});

    // Administrer sa banque n'est pas administrer l'instance : le portail ne
    // doit pas suggérer le contraire.
    afficher(<AppShell>contenu</AppShell>, profilPour('ADMIN'));
    expect(screen.queryByRole('link', { name: 'Administration' })).toBeNull();

    afficher(<AppShell>contenu</AppShell>, PROFIL_AUDITEUR);
    expect(screen.queryByRole('link', { name: 'Administration' })).toBeNull();
  });

  it('affiche les réglages, et réserve l’explication à l’aide contextuelle', async () => {
    simulerApi({ '/api/administration/reglages': () => reponse(200, REGLAGES) });
    afficher(<AdministrationPage />, ADMIN_INSTANCE);

    expect(await screen.findByText(/TRUSTED_PROXIES/)).toBeInTheDocument();
    expect(screen.getByText('172.16.0.0/12')).toBeInTheDocument();
    expect(screen.getByText('Banque Méridienne')).toBeInTheDocument();

    // L'écran dit « lecture seule » ; le pourquoi se lit au survol, pas en
    // paragraphe sous chaque champ (§9.24).
    expect(screen.getByText('lecture seule')).toBeInTheDocument();
    expect(screen.getByLabelText(/invisible du journal/i)).toBeInTheDocument();
  });

  it('dit le refus sans laisser croire à une panne', () => {
    simulerApi({});
    afficher(<AdministrationPage />, profilPour('ADMIN'));

    expect(screen.getByText(/réservé aux administrateurs de l’instance/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/deux habilitations distinctes/i)).toBeInTheDocument();
  });
});
