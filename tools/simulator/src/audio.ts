import { buildWavPcm, INGEST_SAMPLE_RATE } from '@voxecho/shared';
import type { Alea } from './random';

/**
 * Audio « parlé » sans synthèse vocale — CLAUDE.md §4 : deux tonalités
 * alternées suffisent.
 *
 * On imite le tour de parole plutôt que la parole : un interlocuteur occupe
 * la ligne pendant quelques secondes sur sa tonalité, l'autre lui répond sur
 * la sienne, avec de brefs silences entre les tours. Un auditeur qui ouvre le
 * lecteur du portail entend immédiatement deux voix qui se répondent, ce qui
 * suffit à valider la réécoute, la durée et le repérage dans le fichier.
 */

/** Tonalités des deux interlocuteurs, dans la bande téléphonique. */
export const TONALITE_APPELANT = 440;
export const TONALITE_APPELE = 620;

/** Amplitude confortable : audible sans saturer. */
const AMPLITUDE = 0.28 * 0x7fff;

export interface OptionsAudio {
  durationSec: number;
  alea: Alea;
  sampleRate?: number;
}

/** Échantillons d'une conversation simulée de la durée demandée. */
export function conversation(options: OptionsAudio): Int16Array {
  const sampleRate = options.sampleRate ?? INGEST_SAMPLE_RATE;
  const total = Math.round(options.durationSec * sampleRate);
  const samples = new Int16Array(total);

  let position = 0;
  let appelant = true;

  while (position < total) {
    // Un tour de parole dure quelques secondes, suivi d'un court silence.
    const tour = Math.round((options.alea.entier(15, 45) / 10) * sampleRate);
    const silence = Math.round((options.alea.entier(2, 8) / 10) * sampleRate);
    const frequence = appelant ? TONALITE_APPELANT : TONALITE_APPELE;

    const fin = Math.min(position + tour, total);
    for (let index = position; index < fin; index += 1) {
      const t = (index - position) / sampleRate;
      // Enveloppe en fondu : une tonalité coupée net claque désagréablement.
      const fondu = Math.min(
        1,
        (fin - index) / (0.02 * sampleRate),
        (index - position) / (0.02 * sampleRate),
      );
      samples[index] = Math.round(AMPLITUDE * fondu * Math.sin(2 * Math.PI * frequence * t));
    }

    position = fin + silence;
    appelant = !appelant;
  }

  return samples;
}

/** WAV PCM 8 kHz mono conforme au contrat §3, prêt à être déposé. */
export function wavConversation(options: OptionsAudio): Uint8Array {
  return buildWavPcm({
    samples: conversation(options),
    sampleRate: options.sampleRate ?? INGEST_SAMPLE_RATE,
  });
}
