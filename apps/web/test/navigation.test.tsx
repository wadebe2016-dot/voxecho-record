import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell } from '../src/components/AppShell';
import { afficher, PROFIL_AUDITEUR, profilPour, simulerApi } from './helpers';

const ADMIN_INSTANCE = { ...profilPour('ADMIN'), instanceAdmin: true };

/**
 * Navigation principale — CLAUDE.md §9.25.
 *
 * Un seul modèle : lien direct sans sous-section, déroulant au clic sinon. Ce
 * qui se vérifie ici, c'est qu'un menu s'ouvre, se referme, et n'expose que ce
 * que le profil peut ouvrir.
 */
describe('navigation principale', () => {
  it('présente les écrans quotidiens en liens directs', () => {
    simulerApi({});
    afficher(<AppShell>contenu</AppShell>, PROFIL_AUDITEUR);
    const nav = screen.getByRole('navigation', { name: 'Navigation principale' });

    for (const libelle of ['Tableau de bord', 'Enregistrements', 'Journal d’audit', 'Politiques']) {
      expect(within(nav).getByRole('link', { name: libelle })).toBeInTheDocument();
    }
  });

  it('n’ouvre le contenu d’un onglet à sous-sections qu’au clic', async () => {
    simulerApi({});
    afficher(<AppShell>contenu</AppShell>, ADMIN_INSTANCE);

    const onglet = screen.getByRole('button', { name: /Administration/ });
    expect(onglet).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Réglages' })).toBeNull();

    await userEvent.click(onglet);
    expect(onglet).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Réglages' })).toBeInTheDocument();
    // Le déroulant titre ses sections : c'est ce qui le rendra lisible quand
    // il en portera quatre.
    expect(screen.getByText('Instance')).toBeInTheDocument();
  });

  it('se referme à Échap et au clic ailleurs', async () => {
    simulerApi({});
    afficher(<AppShell>contenu</AppShell>, ADMIN_INSTANCE);
    const onglet = screen.getByRole('button', { name: /Administration/ });

    await userEvent.click(onglet);
    await userEvent.keyboard('{Escape}');
    expect(onglet).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(onglet);
    // Un menu resté ouvert derrière l'écran suivant finit par être cliqué sans
    // qu'on le veuille.
    await userEvent.click(screen.getByText('contenu'));
    expect(onglet).toHaveAttribute('aria-expanded', 'false');
  });

  it('s’atteint au clavier, déroulant compris', async () => {
    simulerApi({});
    afficher(<AppShell>contenu</AppShell>, ADMIN_INSTANCE);
    const onglet = screen.getByRole('button', { name: /Administration/ });

    onglet.focus();
    await userEvent.keyboard('{Enter}');
    expect(onglet).toHaveAttribute('aria-expanded', 'true');

    // Le lien du déroulant vient dans l'ordre de tabulation : un menu qu'un
    // clavier ne peut pas parcourir n'est pas une navigation.
    await userEvent.tab();
    expect(screen.getByRole('link', { name: 'Réglages' })).toHaveFocus();
  });

  it('déclare le déroulant qu’il commande, pour les lecteurs d’écran', async () => {
    simulerApi({});
    afficher(<AppShell>contenu</AppShell>, ADMIN_INSTANCE);
    const onglet = screen.getByRole('button', { name: /Administration/ });

    await userEvent.click(onglet);
    const identifiant = onglet.getAttribute('aria-controls');
    expect(identifiant).toBeTruthy();
    expect(document.getElementById(identifiant as string)).toBeInTheDocument();
  });
});
