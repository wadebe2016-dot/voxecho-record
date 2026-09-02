import { describe, expect, it } from 'vitest';
import { buildWavPcm, readWavHeader, WAV_CANONICAL_HEADER_BYTES } from '../src/ingestion/wav';
import { INGEST_SAMPLE_RATE } from '../src/ingestion/layout';

/**
 * Les wav conformes sont fabriqués par `buildWavPcm`, celui-là même dont se
 * sert le simulateur : ce que les tests lisent est exactement ce que le
 * producteur déposera. `format` et `bitsPerSample` sont retouchés à la main
 * pour les cas hors contrat, que le constructeur ne sait pas produire.
 */
function wav(
  options: {
    sampleRate?: number;
    channels?: number;
    bitsPerSample?: number;
    samples?: number;
    format?: number;
  } = {},
): Uint8Array {
  const sampleRate = options.sampleRate ?? INGEST_SAMPLE_RATE;
  const channels = options.channels ?? 1;
  const fichier = buildWavPcm({
    samples: new Int16Array((options.samples ?? sampleRate) * channels),
    sampleRate,
    channels,
  });
  const view = new DataView(fichier.buffer);
  if (options.format !== undefined) view.setUint16(20, options.format, true);
  if (options.bitsPerSample !== undefined) view.setUint16(34, options.bitsPerSample, true);
  return fichier;
}

describe('lecture de l’en-tête WAV', () => {
  it('lit un wav PCM 8 kHz conforme au contrat', () => {
    const fichier = wav({ samples: INGEST_SAMPLE_RATE * 3 });
    const result = readWavHeader(fichier, fichier.byteLength);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sampleRate).toBe(INGEST_SAMPLE_RATE);
    expect(result.value.channels).toBe(1);
    expect(result.value.bitsPerSample).toBe(16);
    expect(result.value.durationSec).toBeCloseTo(3, 5);
    expect(result.value.dataOffset).toBe(WAV_CANONICAL_HEADER_BYTES);
  });

  it('détecte un wav tronqué : le chunk data promet plus que le fichier ne porte', () => {
    const fichier = wav({ samples: INGEST_SAMPLE_RATE * 10 });
    // Le fichier a été coupé en cours d'écriture : l'en-tête, lui, n'a pas bougé.
    const tailleReelle = Math.floor(fichier.byteLength / 2);

    const result = readWavHeader(fichier, tailleReelle);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('tronqué');
  });

  it('refuse ce qui n’est pas un RIFF/WAVE', () => {
    const texte = new TextEncoder().encode('{"schema":1}   ');
    expect(readWavHeader(texte, texte.byteLength)).toEqual({
      ok: false,
      errors: ['en-tête RIFF absent'],
    });
  });

  it('refuse un conteneur RIFF qui n’est pas du WAVE', () => {
    const fichier = wav();
    fichier.set(new TextEncoder().encode('AVI '), 8);
    const result = readWavHeader(fichier, fichier.byteLength);
    expect(result).toEqual({ ok: false, errors: ['conteneur non WAVE'] });
  });

  it('refuse un format compressé : la preuve se conserve en PCM', () => {
    const fichier = wav({ format: 85 }); // MPEG Layer 3
    const result = readWavHeader(fichier, fichier.byteLength);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('non PCM');
  });

  it('signale l’absence du chunk data', () => {
    const fichier = wav().slice(0, 36); // fmt seul
    const result = readWavHeader(fichier, fichier.byteLength);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('data');
  });

  it('rapporte la fréquence réelle d’un wav hors contrat, sans la corriger', () => {
    const fichier = wav({ sampleRate: 16_000, samples: 16_000 });
    const result = readWavHeader(fichier, fichier.byteLength);

    // Le lecteur constate ; c'est l'ingestion qui tranche par rapport au contrat.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sampleRate).toBe(16_000);
    expect(result.value.durationSec).toBeCloseTo(1, 5);
  });

  it('traverse un chunk annexe placé avant data', () => {
    const base = wav({ samples: INGEST_SAMPLE_RATE });
    const annexe = 12; // « LIST » + taille + 4 octets
    const fichier = new Uint8Array(base.byteLength + annexe);
    fichier.set(base.subarray(0, 36), 0);
    const view = new DataView(fichier.buffer);
    const ascii = (offset: number, text: string): void => {
      for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
    };
    ascii(36, 'LIST');
    view.setUint32(40, 4, true);
    fichier.set(base.subarray(36), 36 + annexe);

    const result = readWavHeader(fichier, fichier.byteLength);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.durationSec).toBeCloseTo(1, 5);
  });
});
