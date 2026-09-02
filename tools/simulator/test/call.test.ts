import { describe, expect, it } from 'vitest';
import { parseIngestMetadata, parseRadical } from '@voxecho/shared';
import { dureeSecondes, genererAppel, numeroMobile } from '../src/call';
import { creerAlea } from '../src/random';

/**
 * Le simulateur n'a d'intérêt que s'il produit ce que l'ingestion accepte.
 * Ces tests confrontent donc ses tirages aux validateurs du contrat §3
 * eux-mêmes — les mêmes fonctions que l'api appelle — plutôt qu'à une idée
 * de ce que le contrat dit.
 */
describe('appels simulés', () => {
  const appels = (nombre: number, graine = 1) => {
    const alea = creerAlea(graine);
    return Array.from({ length: nombre }, () => genererAppel(alea));
  };

  it('produit des métadonnées que le contrat §3 valide', () => {
    for (const appel of appels(200)) {
      const resultat = parseIngestMetadata(appel.metadata);
      if (!resultat.ok) throw new Error(`métadonnées refusées : ${resultat.errors.join(', ')}`);
      expect(resultat.ok).toBe(true);
    }
  });

  it('produit un radical que le contrat sait relire, cohérent avec le json', () => {
    for (const appel of appels(200)) {
      const parsed = parseRadical(appel.radical);
      expect(parsed).not.toBeNull();
      // Le nom et les métadonnées doivent concorder : c'est exactement ce que
      // l'ingestion vérifie avant d'accepter une paire.
      expect(parsed?.refci).toBe(appel.metadata.refci);
      expect(parsed?.near).toBe(appel.metadata.near);
      expect(parsed?.far).toBe(appel.metadata.far);
    }
  });

  it('appelle des numéros camerounais à neuf chiffres', () => {
    const alea = creerAlea(7);
    for (let index = 0; index < 200; index += 1) {
      expect(numeroMobile(alea)).toMatch(/^6[2-9]\d{7}$/);
    }
  });

  it('donne un correspondant interne aux appels internes', () => {
    for (const appel of appels(400, 3)) {
      if (appel.metadata.direction !== 'internal') continue;
      expect(appel.metadata.far).toMatch(/^\d{4}$/);
      expect(appel.metadata.far).not.toBe(appel.metadata.near);
    }
  });

  it('tient les durées dans la fourchette du §4 : 15 s à 10 min', () => {
    const alea = creerAlea(11);
    for (let index = 0; index < 500; index += 1) {
      const duree = dureeSecondes(alea);
      expect(duree).toBeGreaterThanOrEqual(15);
      expect(duree).toBeLessThanOrEqual(600);
    }
  });

  it('penche vers les appels courts : une démonstration ne dure pas des heures', () => {
    const alea = creerAlea(13);
    const durees = Array.from({ length: 1000 }, () => dureeSecondes(alea));
    const mediane = durees.sort((a, b) => a - b)[500] as number;
    expect(mediane).toBeLessThan(120);
  });

  it('place les appels en heures ouvrées, du lundi au vendredi', () => {
    for (const appel of appels(300, 5)) {
      const debut = new Date(appel.metadata.startedAt);
      const parsed = parseRadical(appel.radical);
      const heure = Number(parsed?.time.slice(0, 2));
      expect(heure).toBeGreaterThanOrEqual(8);
      expect(heure).toBeLessThanOrEqual(17);
      expect(debut.getUTCDay()).not.toBe(0);
      expect(debut.getUTCDay()).not.toBe(6);
    }
  });

  it('mélange les directions plutôt que d’en produire une seule', () => {
    const directions = new Set(appels(200, 17).map((appel) => appel.metadata.direction));
    expect(directions).toEqual(new Set(['inbound', 'outbound', 'internal']));
  });

  it('rejoue à l’identique à graine égale, et diffère autrement', () => {
    expect(appels(5, 99)).toEqual(appels(5, 99));
    expect(appels(5, 99)).not.toEqual(appels(5, 100));
  });
});
