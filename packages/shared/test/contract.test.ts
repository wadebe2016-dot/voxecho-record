import { describe, expect, it } from 'vitest';
import {
  INGEST_SCHEMA_VERSION,
  parseIngestMetadata,
  type IngestMetadata,
} from '../src/ingestion/contract';

/** L'exemple exact de CLAUDE.md §3 : il fait foi. */
const exempleDuBrief = {
  schema: 1,
  refci: '16778001',
  near: '1001',
  far: '699112233',
  direction: 'outbound',
  startedAt: '2026-09-01T14:30:12+01:00',
  durationSec: 183,
  source: 'cucm-bib',
} satisfies IngestMetadata;

describe('contrat d’ingestion — métadonnées', () => {
  it('accepte l’exemple du brief tel quel', () => {
    const result = parseIngestMetadata(exempleDuBrief);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(exempleDuBrief);
    }
  });

  it('expose la version de schéma reconnue', () => {
    expect(INGEST_SCHEMA_VERSION).toBe(1);
  });

  it.each(['inbound', 'internal', 'outbound'])('accepte la direction %s', (direction) => {
    expect(parseIngestMetadata({ ...exempleDuBrief, direction }).ok).toBe(true);
  });

  it.each(['cucm-bib', 'siprec', 'simulator'])('accepte la source %s', (source) => {
    expect(parseIngestMetadata({ ...exempleDuBrief, source }).ok).toBe(true);
  });

  it('accepte une durée nulle (appel sans réponse capturé)', () => {
    expect(parseIngestMetadata({ ...exempleDuBrief, durationSec: 0 }).ok).toBe(true);
  });

  it('ignore les champs inconnus sans échouer', () => {
    const result = parseIngestMetadata({ ...exempleDuBrief, extra: 'futur champ producteur' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toHaveProperty('extra');
    }
  });
});

describe('contrat d’ingestion — refus (quarantaine)', () => {
  const cas: Array<[string, unknown]> = [
    ['json vide', {}],
    ['null', null],
    ['tableau', []],
    ['chaîne', 'pas un objet'],
    ['schéma absent', { ...exempleDuBrief, schema: undefined }],
    ['schéma futur non pris en charge', { ...exempleDuBrief, schema: 2 }],
    ['refci vide', { ...exempleDuBrief, refci: '' }],
    ['near absent', { ...exempleDuBrief, near: undefined }],
    ['far avec caractères interdits', { ...exempleDuBrief, far: '699 11 22 33' }],
    ['direction inconnue', { ...exempleDuBrief, direction: 'unknown' }],
    ['source inconnue', { ...exempleDuBrief, source: 'asterisk' }],
    ['horodatage sans fuseau', { ...exempleDuBrief, startedAt: '2026-09-01T14:30:12' }],
    ['horodatage non ISO', { ...exempleDuBrief, startedAt: '01/09/2026 14:30' }],
    ['durée négative', { ...exempleDuBrief, durationSec: -1 }],
    ['durée non entière', { ...exempleDuBrief, durationSec: 12.5 }],
    ['durée sous forme de chaîne', { ...exempleDuBrief, durationSec: '183' }],
    ['durée invraisemblable (> 24 h)', { ...exempleDuBrief, durationSec: 90_000 }],
  ];

  it.each(cas)('refuse : %s', (_libelle, entree) => {
    const result = parseIngestMetadata(entree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('ne lève jamais d’exception et nomme le champ fautif', () => {
    const result = parseIngestMetadata({ ...exempleDuBrief, direction: 'unknown' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('direction');
    }
  });

  it('accepte l’horodatage en UTC (suffixe Z)', () => {
    expect(parseIngestMetadata({ ...exempleDuBrief, startedAt: '2026-09-01T13:30:12Z' }).ok).toBe(
      true,
    );
  });
});
