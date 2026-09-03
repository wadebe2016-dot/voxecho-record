import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { LoginPage } from '../src/pages/LoginPage';
import { afficher, reponse, simulerApi } from './helpers';

/**
 * Mention d'instance de démonstration — CLAUDE.md §9.18.
 *
 * Elle n'est pas décorative : sans elle, un visiteur de record.voxecho.cm
 * pourrait croire qu'il regarde les conversations des clients d'une banque.
 * Elle ne doit pas davantage apparaître chez un client, où elle jetterait un
 * doute sur des pièces qui, elles, sont réelles — c'est donc l'instance qui la
 * commande, jamais le portail seul.
 */
describe('mention d’instance de démonstration', () => {
  it('annonce la démonstration quand l’instance le déclare', async () => {
    simulerApi({ '/api/instance': () => reponse(200, { demo: true }) });
    afficher(<LoginPage />, null);

    const bandeau = await screen.findByTestId('bandeau-demonstration');
    expect(bandeau.textContent).toMatch(/aucune conversation réelle/i);
  });

  it('ne dit rien sur une instance ordinaire', async () => {
    simulerApi({ '/api/instance': () => reponse(200, { demo: false }) });
    afficher(<LoginPage />, null);

    await screen.findByRole('button', { name: 'Se connecter' });
    await waitFor(() => {
      expect(screen.queryByTestId('bandeau-demonstration')).toBeNull();
    });
  });

  it('reste utilisable quand l’api ne répond pas', async () => {
    // L'écran de connexion ne doit pas dépendre d'un appel accessoire : une
    // api en panne se constate en essayant de se connecter, pas devant un
    // écran vide.
    simulerApi({});
    afficher(<LoginPage />, null);

    expect(await screen.findByRole('button', { name: 'Se connecter' })).toBeInTheDocument();
    expect(screen.queryByTestId('bandeau-demonstration')).toBeNull();
  });

  it('se présente par ce qu’il fait, sans éditeur ni ville', async () => {
    // Décision produit (§9.20) : cet écran est le premier que voit une DSI
    // bancaire qui évalue l'outil, et un ancrage local y pèse plus lourd que
    // ce qu'il apporte. Le nom de l'éditeur vit dans les documents
    // contractuels, pas sur l'écran de connexion.
    simulerApi({});
    afficher(<LoginPage />, null);

    expect(await screen.findByRole('heading', { name: 'VoxEcho Record' })).toBeInTheDocument();
    expect(screen.getByText(/enregistrement d’appels de conformité/i)).toBeInTheDocument();
    // L'information fonctionnelle du pied de page, elle, reste : elle explique
    // un refus que l'utilisateur rencontrera sinon sans comprendre.
    expect(screen.getByText(/temporairement verrouillé/i)).toBeInTheDocument();

    expect(screen.queryByText(/atlastech/i)).toBeNull();
    expect(screen.queryByText(/douala/i)).toBeNull();
  });
});
