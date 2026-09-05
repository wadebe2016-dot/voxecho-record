import { lirePlanchersReglementaires, plancherDe } from '../src/retention/planchers';

/**
 * Planchers réglementaires — CLAUDE.md §9.30.
 *
 * Deux planchers coexistent et ne disent pas la même chose : celui de
 * l'instance est une règle de maison, dont on déroge par écrit ; celui-ci se
 * veut l'écho d'une obligation extérieure, à laquelle on ne déroge pas par une
 * phrase dans un formulaire.
 */
describe('planchers réglementaires', () => {
  it('vaut zéro tant que rien n’est déclaré', () => {
    // Tant que la cote de texte n'est pas établie (§9.9), le produit ne fait
    // pas semblant de connaître une durée légale.
    const planchers = lirePlanchersReglementaires('');
    expect(plancherDe(planchers, 'confirmation_cheque')).toBe(0);
    expect(plancherDe(planchers, null)).toBe(0);
  });

  it('lit une déclaration par catégorie', () => {
    const planchers = lirePlanchersReglementaires(
      'confirmation_cheque:3650, operation_change:1825',
    );
    expect(plancherDe(planchers, 'confirmation_cheque')).toBe(3650);
    expect(plancherDe(planchers, 'operation_change')).toBe(1825);
    // Une catégorie non déclarée n'hérite de rien : elle n'a pas de plancher.
    expect(plancherDe(planchers, 'autre')).toBe(0);
  });

  it('refuse une déclaration que personne ne saurait relire', () => {
    // Un plancher qu'on croit posé et qui ne l'est pas est pire que pas de
    // plancher du tout : la lecture échoue au démarrage, comme un secret
    // d'exemple non remplacé (§2).
    expect(() => lirePlanchersReglementaires('confirmation_cheque')).toThrow(/format attendu/);
    expect(() => lirePlanchersReglementaires('confirmation_chèque:3650')).toThrow(
      /catégorie inconnue/,
    );
    expect(() => lirePlanchersReglementaires('autre:beaucoup')).toThrow(/nombre de jours/);
    expect(() => lirePlanchersReglementaires('autre:-5')).toThrow(/nombre de jours/);
  });
});
