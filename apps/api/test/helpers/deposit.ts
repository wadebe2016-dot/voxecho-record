import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildWavPcm, INGEST_SAMPLE_RATE, type IngestMetadata } from '@voxecho/shared';

/**
 * Fabrique un dépôt conforme au contrat §3 : le wav d'abord, le json ensuite.
 * Les tests d'ingestion imitent ici exactement ce que fera FreeSWITCH en S5 —
 * si l'ordre ou le nommage changeaient, c'est le contrat qui aurait bougé.
 */

export const METADONNEES_TYPE: IngestMetadata = {
  schema: 1,
  refci: '16778001',
  near: '1001',
  far: '699112233',
  direction: 'outbound',
  startedAt: '2026-09-01T14:30:12+01:00',
  durationSec: 3,
  source: 'simulator',
};

export const RADICAL_TYPE = '20260901-143012_16778001_1001_699112233';

/** Audio silencieux de la durée demandée, au format du contrat. */
export function audio(durationSec: number): Uint8Array {
  return buildWavPcm({ samples: new Int16Array(INGEST_SAMPLE_RATE * durationSec) });
}

export interface DepotOptions {
  /** Sous-répertoire d'INGEST_DIR : le slug du locataire visé. */
  slug: string;
  radical?: string;
  metadata?: Partial<IngestMetadata> | string;
  /** Contenu du wav ; par défaut un audio de `durationSec` secondes. */
  wav?: Uint8Array;
  /** Ne dépose que le wav, ou que le json. */
  sans?: 'wav' | 'json';
}

export interface Depot {
  dir: string;
  radical: string;
  cheminWav: string;
  cheminJson: string;
}

export async function deposer(ingestDir: string, options: DepotOptions): Promise<Depot> {
  const radical = options.radical ?? RADICAL_TYPE;
  const dir = join(ingestDir, options.slug);
  await mkdir(dir, { recursive: true });

  const meta =
    typeof options.metadata === 'string'
      ? options.metadata
      : JSON.stringify({ ...METADONNEES_TYPE, ...options.metadata }, null, 2);

  const cheminWav = join(dir, `${radical}.wav`);
  const cheminJson = join(dir, `${radical}.json`);

  // Le wav arrive en premier, le json ferme la paire (contrat §3).
  if (options.sans !== 'wav') {
    const contenu =
      options.wav ??
      audio(
        typeof options.metadata === 'object' && options.metadata?.durationSec !== undefined
          ? options.metadata.durationSec
          : METADONNEES_TYPE.durationSec,
      );
    await writeFile(cheminWav, contenu);
  }
  if (options.sans !== 'json') {
    await writeFile(cheminJson, meta);
  }

  return { dir, radical, cheminWav, cheminJson };
}
