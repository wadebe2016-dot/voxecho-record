import { describe, expect, it } from 'vitest';
import { dayRangeToInstants, isCalendarDay } from '../src/api/recordings';

/**
 * Les bornes de recherche du §6 sont saisies en jours, pas en instants. Un
 * jour qui n'existe pas doit être refusé plutôt que reporté : c'est la seule
 * façon que le journal d'audit consigne la recherche qui a réellement eu lieu.
 */
describe('jour du calendrier', () => {
  it('accepte un jour ordinaire', () => {
    expect(isCalendarDay('2026-09-01')).toBe(true);
  });

  it('accepte le 29 février d’une année bissextile et refuse celui des autres', () => {
    expect(isCalendarDay('2024-02-29')).toBe(true);
    expect(isCalendarDay('2026-02-29')).toBe(false);
    // 2100 n'est pas bissextile : la règle séculaire compte aussi.
    expect(isCalendarDay('2100-02-29')).toBe(false);
    expect(isCalendarDay('2000-02-29')).toBe(true);
  });

  it.each([
    ['un jour reporté au mois suivant', '2026-02-30'],
    ['un 31 dans un mois de 30 jours', '2026-04-31'],
    ['un jour hors du mois', '2026-09-32'],
    ['le jour zéro', '2026-09-00'],
    ['le mois zéro', '2026-00-10'],
    ['un treizième mois', '2026-13-45'],
  ])('refuse %s (%s)', (_libelle, valeur) => {
    expect(isCalendarDay(valeur)).toBe(false);
  });

  it.each([
    ['une date à l’européenne', '01/09/2026'],
    ['un mois sans zéro initial', '2026-9-1'],
    ['un horodatage complet', '2026-09-01T14:30:12+01:00'],
    ['du vide', ''],
  ])('refuse %s (%s) : la forme d’abord', (_libelle, valeur) => {
    expect(isCalendarDay(valeur)).toBe(false);
  });

  it('ne prend pas une année à deux chiffres pour le siècle dernier', () => {
    // `Date.UTC(99, …)` désigne 1999 : sans le contrôle du report, « 0099 »
    // passerait pour un jour valable.
    expect(isCalendarDay('0099-01-01')).toBe(false);
  });
});

describe('bornes d’un intervalle de jours', () => {
  it('couvre la journée entière, du premier au dernier instant de Douala', () => {
    const bornes = dayRangeToInstants('2026-09-01', '2026-09-01');
    expect(bornes.gte?.toISOString()).toBe('2026-08-31T23:00:00.000Z');
    expect(bornes.lte?.toISOString()).toBe('2026-09-01T22:59:59.999Z');
  });

  it('accepte une borne seule', () => {
    expect(dayRangeToInstants('2026-09-01', undefined).lte).toBeUndefined();
    expect(dayRangeToInstants(undefined, '2026-09-01').gte).toBeUndefined();
  });

  it('lève sur un jour inexistant plutôt que de le reporter au suivant', () => {
    // Sans cela, « du 30 février » cherchait sur le 1er mars sans le dire.
    expect(() => dayRangeToInstants('2026-02-30')).toThrow(RangeError);
    expect(() => dayRangeToInstants(undefined, '2026-02-30')).toThrow(/inexistant au calendrier/);
    expect(() => dayRangeToInstants('2026-13-45')).toThrow(RangeError);
  });
});
