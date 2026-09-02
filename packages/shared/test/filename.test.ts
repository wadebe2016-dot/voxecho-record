import { describe, expect, it } from 'vitest';
import { buildRadical, parseRadical, radicalOf } from '../src/ingestion/filename';
import type { IngestMetadata } from '../src/ingestion/contract';

const RADICAL = '20260901-143012_16778001_1001_699112233';

describe('nommage des fichiers déposés', () => {
  it('découpe le radical de l’exemple du brief', () => {
    expect(parseRadical(RADICAL)).toEqual({
      date: '20260901',
      time: '143012',
      refci: '16778001',
      near: '1001',
      far: '699112233',
    });
  });

  it.each([
    ['segment manquant', '20260901-143012_16778001_1001'],
    ['date trop courte', '2026091-143012_16778001_1001_699112233'],
    ['séparateur absent', '20260901143012_16778001_1001_699112233'],
    ['espace dans un numéro', '20260901-143012_16778001_1001_699 112233'],
    ['vide', ''],
  ])('refuse un radical non conforme : %s', (_libelle, radical) => {
    expect(parseRadical(radical)).toBeNull();
  });

  it('retire l’extension wav ou json', () => {
    expect(radicalOf(`${RADICAL}.wav`)).toBe(RADICAL);
    expect(radicalOf(`${RADICAL}.json`)).toBe(RADICAL);
    expect(radicalOf(`${RADICAL}.WAV`)).toBe(RADICAL);
    expect(radicalOf(RADICAL)).toBe(RADICAL);
  });

  it('reconstruit le radical à partir des métadonnées (heure locale du producteur)', () => {
    const metadata: IngestMetadata = {
      schema: 1,
      refci: '16778001',
      near: '1001',
      far: '699112233',
      direction: 'outbound',
      startedAt: '2026-09-01T14:30:12+01:00',
      durationSec: 183,
      source: 'cucm-bib',
    };
    expect(buildRadical(metadata)).toBe(RADICAL);
  });

  it('reconstruit correctement un horodatage à décalage négatif', () => {
    const metadata: IngestMetadata = {
      schema: 1,
      refci: 'A1',
      near: '1001',
      far: '699112233',
      direction: 'inbound',
      startedAt: '2026-09-01T23:45:00-04:30',
      durationSec: 10,
      source: 'simulator',
    };
    expect(buildRadical(metadata)).toBe('20260901-234500_A1_1001_699112233');
  });

  it('boucle : un radical construit est relisible', () => {
    const metadata: IngestMetadata = {
      schema: 1,
      refci: '16778002',
      near: '1042',
      far: '677001122',
      direction: 'internal',
      startedAt: '2026-12-31T23:59:59+01:00',
      durationSec: 5,
      source: 'siprec',
    };
    const parsed = parseRadical(buildRadical(metadata));
    expect(parsed).not.toBeNull();
    expect(parsed?.refci).toBe('16778002');
    expect(parsed?.date).toBe('20261231');
    expect(parsed?.time).toBe('235959');
  });
});
