import { describe, expect, it } from 'vitest';
import { isTenantSlug, storageRelativePath } from '../src/ingestion/layout';

const RADICAL = '20260901-143012_16778001_1001_699112233';
const TENANT = '3f2b1c4d-0000-4000-8000-000000000001';

describe('slug de locataire', () => {
  it.each(['banque-cemac', 'mfi-b', 'a1', 'x'])('accepte « %s »', (slug) => {
    expect(isTenantSlug(slug)).toBe(true);
  });

  it.each([
    ['majuscules', 'Banque-CEMAC'],
    ['accent', 'microfinance-témoin'],
    ['espace', 'banque cemac'],
    ['point', 'banque.cemac'],
    ['tiret en tête', '-banque'],
    ['tiret en fin', 'banque-'],
    ['vide', ''],
    ['remontée de répertoire', '..'],
    ['séparateur de chemin', 'a/b'],
  ])('refuse %s', (_libelle, slug) => {
    expect(isTenantSlug(slug)).toBe(false);
  });
});

describe('rangement dans STORAGE_DIR', () => {
  it('range selon l’année et le mois lus dans le radical', () => {
    expect(storageRelativePath(TENANT, RADICAL)).toBe(`${TENANT}/2026/09/${RADICAL}.wav`);
  });

  it('classe un appel de fin de mois sur la date du producteur, sans conversion', () => {
    // 31 décembre 23h58 heure locale : un décalage de fuseau appliqué ici
    // basculerait la preuve dans l'année suivante.
    const radical = '20261231-235800_16778002_1001_699112233';
    expect(storageRelativePath(TENANT, radical)).toBe(`${TENANT}/2026/12/${radical}.wav`);
  });

  it('refuse un radical hors contrat plutôt que d’inventer un chemin', () => {
    expect(storageRelativePath(TENANT, 'appel-du-matin')).toBeNull();
  });
});
