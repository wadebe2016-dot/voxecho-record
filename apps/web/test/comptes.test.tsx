import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserSummary } from '@voxecho/shared';
import { ComptesPage } from '../src/pages/ComptesPage';
import { MotDePassePage } from '../src/pages/MotDePassePage';
import { AppShell } from '../src/components/AppShell';
import { afficher, PROFIL_AUDITEUR, profilPour, reponse, simulerApi } from './helpers';

const ADMIN = profilPour('ADMIN');

const COMPTES: UserSummary[] = [
  {
    id: 'u-ADMIN',
    email: 'admin@demo.cm',
    role: 'ADMIN',
    active: true,
    instanceAdmin: true,
    mustChangePassword: false,
    lastLoginAt: '2026-09-03T08:00:00.000Z',
    lockedUntil: null,
    createdAt: '2026-09-01T08:00:00.000Z',
  },
  {
    id: 'u-2',
    email: 'auditeur@demo.cm',
    role: 'AUDITOR',
    active: true,
    instanceAdmin: false,
    mustChangePassword: true,
    lastLoginAt: null,
    lockedUntil: null,
    createdAt: '2026-09-02T08:00:00.000Z',
  },
];

/**
 * Écrans des comptes — CLAUDE.md §9.26.
 */
describe('gestion des comptes', () => {
  it('liste les comptes et signale ce qui doit se voir', async () => {
    simulerApi({ '/api/users': () => reponse(200, COMPTES) });
    afficher(<ComptesPage />, ADMIN);

    expect(await screen.findByText('auditeur@demo.cm')).toBeInTheDocument();
    expect(screen.getByText('mot de passe à renouveler')).toBeInTheDocument();
    expect(screen.getByText('instance')).toBeInTheDocument();
  });

  it('affiche le mot de passe provisoire une seule fois, à la création', async () => {
    // La création et le rechargement partagent le chemin : c'est la méthode
    // qui les distingue.
    vi.stubGlobal(
      'fetch',
      vi.fn((_entree: string | URL, init?: RequestInit) =>
        Promise.resolve(
          (init?.method ?? 'GET') === 'POST'
            ? reponse(201, {
                compte: { ...COMPTES[1], id: 'u-3', email: 'nouveau@demo.cm' },
                motDePasseProvisoire: 'KWES-2RTP-9MND-4XQF',
              })
            : reponse(200, COMPTES),
        ),
      ),
    );
    afficher(<ComptesPage />, ADMIN);
    await screen.findByText('auditeur@demo.cm');

    await userEvent.type(screen.getByLabelText('Adresse électronique'), 'nouveau@demo.cm');
    await userEvent.click(screen.getByRole('button', { name: 'Créer' }));

    // C'est le seul endroit où il paraîtra : il n'est stocké nulle part en clair.
    const encart = await screen.findByTestId('mot-de-passe-provisoire');
    expect(encart).toHaveTextContent('KWES-2RTP-9MND-4XQF');
  });

  it('n’offre pas de modifier son propre compte', async () => {
    // Se rétrograder ou se désactiver soi-même, c'est se fermer la porte de
    // l'intérieur : l'api le refuse, l'écran ne le propose pas.
    simulerApi({ '/api/users': () => reponse(200, COMPTES) });
    afficher(<ComptesPage />, { ...ADMIN, id: 'u-ADMIN', email: 'admin@demo.cm' });

    await screen.findByText('admin@demo.cm');
    expect(screen.getByLabelText('Rôle de admin@demo.cm')).toBeDisabled();
    const lignes = screen.getAllByRole('row');
    const ligneAdmin = lignes.find((ligne) => ligne.textContent?.includes('admin@demo.cm'));
    const desactiver = ligneAdmin?.querySelector('button');
    expect(desactiver).toBeDisabled();
  });

  it('remonte le refus de l’api en détail, sans le reformuler', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_entree: string | URL, init?: RequestInit) =>
        Promise.resolve(
          (init?.method ?? 'GET') === 'POST'
            ? reponse(400, {
                message: 'Compte refusé.',
                details: ['Au moins 12 caractères.', 'Trop proche d’un mot de passe courant.'],
              })
            : reponse(200, COMPTES),
        ),
      ),
    );
    afficher(<ComptesPage />, ADMIN);
    await screen.findByText('auditeur@demo.cm');

    await userEvent.type(screen.getByLabelText('Adresse électronique'), 'x@demo.cm');
    await userEvent.click(screen.getByRole('button', { name: 'Créer' }));

    const alerte = await screen.findByRole('alert');
    expect(alerte).toHaveTextContent('Au moins 12 caractères.');
    expect(alerte).toHaveTextContent('Trop proche d’un mot de passe courant.');
  });

  it('ouvre l’entrée « Comptes » à l’ADMIN', async () => {
    simulerApi({});
    afficher(<AppShell>contenu</AppShell>, ADMIN);

    await userEvent.click(screen.getByRole('button', { name: /Administration/ }));
    expect(screen.getByRole('link', { name: 'Comptes' })).toBeInTheDocument();
  });

  it('ne l’ouvre pas à un auditeur', () => {
    simulerApi({});
    afficher(<AppShell>contenu</AppShell>, PROFIL_AUDITEUR);

    expect(screen.queryByRole('button', { name: /Administration/ })).toBeNull();
  });
});

describe('renouvellement du mot de passe', () => {
  it('refuse deux saisies différentes sans appeler l’api', async () => {
    const faux = simulerApi({});
    afficher(<MotDePassePage />, { ...PROFIL_AUDITEUR, mustChangePassword: true });

    await userEvent.type(screen.getByLabelText('Mot de passe actuel'), 'PROV-ISOI-RE00-1234');
    await userEvent.type(screen.getByLabelText('Nouveau mot de passe'), 'Ngoma!Kwessi-2026');
    await userEvent.type(screen.getByLabelText('Confirmation'), 'Ngoma!Kwessi-2027');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/diffèrent/i);
    expect(faux.mock.calls.some(([url]) => String(url).includes('/auth/password'))).toBe(false);
  });

  it('laisse sortir par la déconnexion', async () => {
    simulerApi({});
    afficher(<MotDePassePage />, { ...PROFIL_AUDITEUR, mustChangePassword: true });

    // Un écran dont on ne peut pas sortir est un piège : la déconnexion reste
    // offerte même quand rien d'autre ne l'est.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Se déconnecter/ })).toBeInTheDocument();
    });
  });
});
