/**
 * Lecture de l'en-tête WAV — contrat §3 : « audio mixé, WAV PCM 8kHz ».
 *
 * L'ingestion doit vérifier la taille et la durée avant d'accepter un fichier
 * comme preuve. Tout se lit dans l'en-tête RIFF : inutile de décoder l'audio,
 * il suffit de constater que le fichier annonce ce qu'il contient réellement.
 * Un wav tronqué se trahit ici — son chunk `data` promet plus d'octets que le
 * fichier n'en compte.
 *
 * Ce module est volontairement sans dépendance et sans `Buffer` : le
 * simulateur (tools/) fabrique ses en-têtes avec les mêmes constantes.
 */

/** Taille de l'en-tête canonique RIFF/WAVE PCM, sans chunk annexe. */
export const WAV_CANONICAL_HEADER_BYTES = 44;

export interface WavHeader {
  readonly channels: number;
  readonly sampleRate: number;
  readonly bitsPerSample: number;
  /** Octets annoncés par le chunk `data`. */
  readonly dataBytes: number;
  /** Décalage du premier octet d'audio dans le fichier. */
  readonly dataOffset: number;
  /** Durée déduite de la taille des données et du débit. */
  readonly durationSec: number;
}

export type WavHeaderResult = { ok: true; value: WavHeader } | { ok: false; errors: string[] };

const RIFF = 0x52494646; // « RIFF »
const WAVE = 0x57415645; // « WAVE »
const FMT = 0x666d7420; // « fmt  »
const DATA = 0x64617461; // « data »
const PCM = 1;

/**
 * Lit l'en-tête d'un wav. `fileSize` est la taille réelle du fichier sur
 * disque : c'est en la confrontant aux tailles annoncées qu'on détecte une
 * troncature. `header` peut ne contenir que le début du fichier, tant qu'il
 * couvre les chunks `fmt ` et `data` (4 Kio suffisent en pratique).
 *
 * Ne lève jamais : un fichier illisible part en quarantaine avec ses motifs.
 */
export function readWavHeader(header: Uint8Array, fileSize: number): WavHeaderResult {
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const errors: string[] = [];

  if (header.byteLength < 12 || view.getUint32(0, false) !== RIFF) {
    return { ok: false, errors: ['en-tête RIFF absent'] };
  }
  if (view.getUint32(8, false) !== WAVE) {
    return { ok: false, errors: ['conteneur non WAVE'] };
  }

  const riffSize = view.getUint32(4, true);
  if (riffSize + 8 > fileSize) {
    errors.push(
      `fichier tronqué : RIFF annonce ${riffSize + 8} octets, le fichier en compte ${fileSize}`,
    );
  }

  let format: number | null = null;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataBytes: number | null = null;
  let dataOffset = 0;

  // Parcours des chunks : un producteur peut intercaler LIST, fact, etc.
  let offset = 12;
  while (offset + 8 <= header.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === FMT && body + 16 <= header.byteLength) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === DATA) {
      dataBytes = size;
      dataOffset = body;
      break; // l'audio suit : rien à lire au-delà.
    }

    // Les chunks sont alignés sur un nombre pair d'octets.
    offset = body + size + (size % 2);
  }

  if (format === null) return { ok: false, errors: [...errors, 'chunk « fmt » absent'] };
  if (dataBytes === null) return { ok: false, errors: [...errors, 'chunk « data » absent'] };

  if (format !== PCM) errors.push(`format ${format} non PCM`);
  if (channels < 1) errors.push('nombre de canaux invalide');
  if (bitsPerSample < 8 || bitsPerSample % 8 !== 0) {
    errors.push(`résolution ${bitsPerSample} bits invalide`);
  }
  if (sampleRate < 1) errors.push("fréquence d'échantillonnage invalide");
  if (dataOffset + dataBytes > fileSize) {
    errors.push(
      `audio tronqué : le chunk « data » annonce ${dataBytes} octets, le fichier n'en contient que ${Math.max(0, fileSize - dataOffset)}`,
    );
  }
  if (errors.length > 0) return { ok: false, errors };

  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  return {
    ok: true,
    value: {
      channels,
      sampleRate,
      bitsPerSample,
      dataBytes,
      dataOffset,
      durationSec: dataBytes / byteRate,
    },
  };
}

export interface WavPcmOptions {
  /** Échantillons signés 16 bits. */
  readonly samples: Int16Array;
  readonly sampleRate?: number;
  readonly channels?: number;
}

/**
 * Fabrique un wav PCM 16 bits canonique. C'est le pendant de
 * `readWavHeader` : le simulateur (§4) et les tests produisent leurs fichiers
 * ici, de sorte que le format déposé et le format attendu ne puissent pas
 * diverger sans qu'un test le voie.
 */
export function buildWavPcm(options: WavPcmOptions): Uint8Array {
  const sampleRate = options.sampleRate ?? 8_000;
  const channels = options.channels ?? 1;
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const dataBytes = options.samples.length * 2;

  const buffer = new ArrayBuffer(WAV_CANONICAL_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let index = 0; index < options.samples.length; index += 1) {
    view.setInt16(WAV_CANONICAL_HEADER_BYTES + index * 2, options.samples[index] ?? 0, true);
  }
  return new Uint8Array(buffer);
}
