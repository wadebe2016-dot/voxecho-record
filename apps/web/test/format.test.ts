import { describe, expect, it } from 'vitest';
import {
  abregerEmpreinte,
  formatDuree,
  formatHorodatage,
  formatTaille,
  libelleDirection,
  libelleRole,
  libelleStatut,
} from '../src/lib/format';

describe('mises en forme', () => {
  it('affiche l’horodatage en heure de Douala', () => {
    // 13:30:12 UTC = 14:30:12 à Douala (UTC+1, sans heure d'été).
    expect(formatHorodatage('2026-09-01T13:30:12Z')).toBe('01/09/2026 14:30:12');
  });

  it('affiche l’horodatage identique quel que soit le fuseau d’origine', () => {
    expect(formatHorodatage('2026-09-01T14:30:12+01:00')).toBe('01/09/2026 14:30:12');
  });

  it('signale un horodatage illisible sans casser le tableau', () => {
    expect(formatHorodatage('pas une date')).toBe('—');
  });

  it.each([
    [0, '0:00'],
    [9, '0:09'],
    [183, '3:03'],
    [600, '10:00'],
    [3765, '1:02:45'],
  ])('met en forme une durée de %i s', (secondes, attendu) => {
    expect(formatDuree(secondes)).toBe(attendu);
  });

  it('refuse une durée absurde', () => {
    expect(formatDuree(-1)).toBe('—');
    expect(formatDuree(Number.NaN)).toBe('—');
  });

  it.each([
    [0, '0 o'],
    [512, '512 o'],
    [2048, '2,0 Kio'],
    [2_928_000, '2,8 Mio'],
  ])('met en forme une taille de %i octets', (octets, attendu) => {
    expect(formatTaille(octets)).toBe(attendu);
  });

  it('traduit les libellés du domaine', () => {
    expect(libelleDirection('outbound')).toBe('Sortant');
    expect(libelleDirection('inbound')).toBe('Entrant');
    expect(libelleStatut('hold')).toBe('Sous conservation');
    expect(libelleRole('AUDITOR')).toBe('Auditeur');
  });

  it('rend un libellé inconnu tel quel plutôt que vide', () => {
    expect(libelleStatut('inconnu')).toBe('inconnu');
  });

  it('abrège l’empreinte sans la tronquer en base', () => {
    const sha = 'a'.repeat(56) + 'bcdefghi';
    expect(abregerEmpreinte(sha)).toBe('aaaaaaaa…bcdefghi');
    expect(abregerEmpreinte('court')).toBe('court');
  });
});
