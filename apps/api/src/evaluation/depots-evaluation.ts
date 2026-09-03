import { randomInt } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildWavPcm,
  INGEST_OPERATION_CATEGORIES,
  INGEST_SAMPLE_RATE,
  type IngestMetadata,
} from '@voxecho/shared';

/**
 * Dépôts du jeu d'évaluation — CLAUDE.md §9.18 et §9.21.
 *
 * Ils passent par `INGEST_DIR`, comme le fera la capture : c'est le chemin
 * réel du produit, contrat §3 compris, qui les range, les empreint et les
 * scelle. Une instance remplie par des insertions directes en base montrerait
 * des enregistrements que l'ingestion n'a jamais vus — exactement ce qu'un
 * contrôleur ne doit pas trouver, et ce qu'aucun test ne vérifierait.
 */

export const SLUG_EVALUATION = 'banque-meridienne';

export interface OptionsDepot {
  ingestDir: string;
  slug?: string;
  /** Profondeur du jeu, en jours écoulés. */
  jours?: number;
  /** Durée maximale d'un appel : un jeu d'évaluation n'a pas à peser. */
  dureeMaxSec?: number;
  /** Ajoute un dépôt malformé, pour que les quarantaines ne soient pas vides. */
  avecQuarantaine?: boolean;
}

/** Numéro camerounais plausible, comme en produit le simulateur du §4. */
function numero(): string {
  return `6${String(randomInt(10_000_000, 99_999_999))}`;
}

/** Horodatage d'Africa/Douala — UTC+1 toute l'année, pas d'heure d'été. */
function horodatage(joursAvant: number, heure: number, minute: number): string {
  const quand = new Date();
  quand.setUTCDate(quand.getUTCDate() - joursAvant);
  const iso = new Date(
    Date.UTC(
      quand.getUTCFullYear(),
      quand.getUTCMonth(),
      quand.getUTCDate(),
      heure - 1,
      minute,
      randomInt(0, 60),
    ),
  ).toISOString();
  return `${iso.slice(0, 19)}+01:00`;
}

/** Radical du contrat §3 : l'heure locale du producteur, telle qu'écrite. */
function radicalDe(meta: IngestMetadata): string {
  const d = meta.startedAt;
  return (
    `${d.slice(0, 4)}${d.slice(5, 7)}${d.slice(8, 10)}-` +
    `${d.slice(11, 13)}${d.slice(14, 16)}${d.slice(17, 19)}_` +
    `${meta.refci}_${meta.near}_${meta.far}`
  );
}

/** Deux tonalités alternées : de quoi entendre que le lecteur fonctionne. */
function audio(secondes: number): Uint8Array {
  const echantillons = new Int16Array(INGEST_SAMPLE_RATE * secondes);
  for (let i = 0; i < echantillons.length; i += 1) {
    const hertz = Math.floor(i / INGEST_SAMPLE_RATE) % 2 === 0 ? 440 : 620;
    echantillons[i] = Math.round(6000 * Math.sin((2 * Math.PI * hertz * i) / INGEST_SAMPLE_RATE));
  }
  return buildWavPcm({ samples: echantillons });
}

async function deposer(
  dir: string,
  meta: IngestMetadata,
  options: { corrompu?: boolean } = {},
): Promise<void> {
  const radical = radicalDe(meta);
  await writeFile(join(dir, `${radical}.wav`), audio(meta.durationSec));
  // Le json ferme la paire, toujours en dernier (contrat §3).
  await writeFile(
    join(dir, `${radical}.json`),
    options.corrompu === true ? '{ "schema": 1, "refci": ' : JSON.stringify(meta, null, 2),
  );
}

export interface ResultatDepot {
  appels: number;
  quarantaines: number;
  repertoire: string;
}

export async function deposerJeuDEvaluation(options: OptionsDepot): Promise<ResultatDepot> {
  const slug = options.slug ?? SLUG_EVALUATION;
  const jours = options.jours ?? 12;
  const dureeMax = options.dureeMaxSec ?? 480;
  // Un jeu réduit — celui des tests — peut demander des appels plus courts que
  // le plancher habituel : le minimum s'y adapte plutôt que d'être impossible.
  const dureeMin = Math.min(20, dureeMax);
  const dir = join(options.ingestDir, slug);
  await mkdir(dir, { recursive: true });

  let appels = 0;
  for (let jour = 0; jour < jours; jour += 1) {
    for (let appel = 0; appel < randomInt(2, 6); appel += 1) {
      await deposer(dir, {
        schema: 1,
        refci: String(randomInt(10_000_000, 99_999_999)),
        near: String(randomInt(1001, 1099)),
        far: numero(),
        direction: randomInt(0, 2) === 0 ? 'outbound' : 'inbound',
        startedAt: horodatage(jour, randomInt(8, 18), randomInt(0, 60)),
        durationSec: dureeMin === dureeMax ? dureeMax : randomInt(dureeMin, dureeMax),
        source: 'cucm-bib',
        category: INGEST_OPERATION_CATEGORIES[randomInt(0, INGEST_OPERATION_CATEGORIES.length)],
      });
      appels += 1;
    }
  }

  let quarantaines = 0;
  if (options.avecQuarantaine !== false) {
    // Le tableau de bord montre alors ce qu'il doit montrer : que la chaîne
    // écarte ce qui n'est pas conforme, et ne le détruit pas en silence.
    await deposer(
      dir,
      {
        schema: 1,
        refci: '90000001',
        near: '1001',
        far: numero(),
        direction: 'inbound',
        startedAt: horodatage(1, 11, 30),
        durationSec: 42,
        source: 'cucm-bib',
      },
      { corrompu: true },
    );
    quarantaines = 1;
  }

  return { appels, quarantaines, repertoire: dir };
}
