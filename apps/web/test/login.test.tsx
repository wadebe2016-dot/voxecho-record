import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../src/App';
import { afficher, PROFIL_AUDITEUR, reponse, simulerApi } from './helpers';

describe('connexion au portail', () => {
  it('présente le formulaire en français quand aucune session n’est ouverte', async () => {
    simulerApi({});
    afficher(<App />);

    expect(await screen.findByLabelText('Adresse électronique')).toBeInTheDocument();
    expect(screen.getByLabelText('Mot de passe')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Se connecter' })).toBeInTheDocument();
    expect(screen.getByText(/chaque consultation est tracée/i)).toBeInTheDocument();
  });

  it('ouvre la session et affiche le bandeau du locataire', async () => {
    simulerApi({
      '/api/auth/login': () =>
        reponse(200, { accessToken: 'acces', refreshToken: 'rafraichissement', expiresIn: '15m' }),
      '/api/auth/me': () => reponse(200, PROFIL_AUDITEUR),
      '/api/recordings': () =>
        reponse(200, { items: [], total: 0, page: 1, pageSize: 25, pageCount: 0 }),
    });
    afficher(<App />);

    await userEvent.type(await screen.findByLabelText('Adresse électronique'), 'auditeur@demo.cm');
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'Demo!2026');
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(await screen.findByTestId('bandeau-locataire')).toHaveTextContent(
      'Banque de démonstration CEMAC',
    );
    expect(screen.getByText(/auditeur@demo\.cm · Auditeur/)).toBeInTheDocument();
  });

  it('conserve les jetons pour la durée de l’onglet seulement', async () => {
    simulerApi({
      '/api/auth/login': () =>
        reponse(200, { accessToken: 'acces', refreshToken: 'rafraichissement', expiresIn: '15m' }),
      '/api/auth/me': () => reponse(200, PROFIL_AUDITEUR),
      '/api/recordings': () =>
        reponse(200, { items: [], total: 0, page: 1, pageSize: 25, pageCount: 0 }),
    });
    afficher(<App />);

    await userEvent.type(await screen.findByLabelText('Adresse électronique'), 'auditeur@demo.cm');
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'Demo!2026');
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }));

    await waitFor(() => expect(sessionStorage.getItem('voxecho.accessToken')).toBe('acces'));
    expect(localStorage.getItem('voxecho.accessToken')).toBeNull();
  });

  it('affiche le message du serveur quand les identifiants sont refusés', async () => {
    simulerApi({
      '/api/auth/login': () => reponse(401, { message: 'Identifiants invalides.' }),
    });
    afficher(<App />);

    await userEvent.type(await screen.findByLabelText('Adresse électronique'), 'auditeur@demo.cm');
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'MauvaisMotDePasse');
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Identifiants invalides.');
    expect(sessionStorage.getItem('voxecho.accessToken')).toBeNull();
  });

  it('affiche le message de verrouillage sans le reformuler', async () => {
    simulerApi({
      '/api/auth/login': () =>
        reponse(403, {
          message: 'Compte temporairement verrouillé après plusieurs échecs de connexion.',
        }),
    });
    afficher(<App />);

    await userEvent.type(await screen.findByLabelText('Adresse électronique'), 'auditeur@demo.cm');
    await userEvent.type(screen.getByLabelText('Mot de passe'), 'Demo!2026');
    await userEvent.click(screen.getByRole('button', { name: 'Se connecter' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/verrouillé/);
  });
});
