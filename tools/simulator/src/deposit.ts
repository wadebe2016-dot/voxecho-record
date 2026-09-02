import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { INGEST_AUDIO_EXTENSION, INGEST_METADATA_EXTENSION } from '@voxecho/shared';
import { wavConversation } from './audio';
import { genererAppel, type AppelSimule } from './call';
import type { Alea } from './random';

/**
 * Dépôt d'un appel simulé, dans l'ordre du contrat §3 : **le wav d'abord, le
 * json en dernier**. C'est ce que fera le script post-enregistrement de
 * FreeSWITCH en S5 ; le simulateur n'a pas le droit d'être plus commode que
 * lui, sinon l'ingestion serait éprouvée sur un cas qui n'arrivera jamais.
 */

/** Avaries que sait produire `--corrupt`, et ce que l'ingestion doit en faire. */
export const AVARIES = ['json-malforme', 'wav-tronque'] as const;
export type Avarie = (typeof AVARIES)[number];

export interface OptionsDepot {
  ingestDir: string;
  /** Slug du locataire visé : le dépôt va dans `INGEST_DIR/<slug>/`. */
  slug: string;
  alea: Alea;
  /** Abîme volontairement le dépôt : il doit finir en quarantaine. */
  avarie?: Avarie;
  jour?: Date;
}

export interface Depot {
  readonly appel: AppelSimule;
  readonly slug: string;
  readonly cheminWav: string;
  readonly cheminJson: string;
  readonly avarie?: Avarie;
  readonly octets: number;
}

export async function deposerAppel(options: OptionsDepot): Promise<Depot> {
  const appel = genererAppel(options.alea, options.jour ? { jour: options.jour } : {});
  const repertoire = join(options.ingestDir, options.slug);
  await mkdir(repertoire, { recursive: true });

  const cheminWav = join(repertoire, `${appel.radical}${INGEST_AUDIO_EXTENSION}`);
  const cheminJson = join(repertoire, `${appel.radical}${INGEST_METADATA_EXTENSION}`);

  let wav = wavConversation({ durationSec: appel.metadata.durationSec, alea: options.alea });
  if (options.avarie === 'wav-tronque') {
    // Coupé en cours d'écriture : l'en-tête promet plus que le fichier ne porte.
    wav = wav.slice(0, Math.max(64, Math.floor(wav.byteLength / 3)));
  }
  await writeFile(cheminWav, wav);

  const json =
    options.avarie === 'json-malforme'
      ? `{ "schema": 1, "refci": "${appel.metadata.refci}", `
      : JSON.stringify(appel.metadata, null, 2);
  await writeFile(cheminJson, json, 'utf8');

  return {
    appel,
    slug: options.slug,
    cheminWav,
    cheminJson,
    octets: wav.byteLength,
    ...(options.avarie ? { avarie: options.avarie } : {}),
  };
}
