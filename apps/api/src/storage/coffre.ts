import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { open, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';

/**
 * Chiffrement des pièces au repos — CLAUDE.md §8 et §9.13.
 *
 * Le §8 demande « AES-256-GCM par fichier ». Un fichier scellé d'un seul tenant
 * ne se lit pas par plages : il faudrait tout déchiffrer à chaque requête d'un
 * lecteur audio, et le `Range` du §6 ne servirait plus à rien. Le fichier est
 * donc découpé en **trames de taille fixe**, chacune scellée séparément — même
 * algorithme, même garantie d'authenticité, mais un octet quelconque se
 * retrouve en déchiffrant une seule trame.
 *
 * Format du conteneur, tout en gros-boutiste :
 *
 * ```
 *   0  magic       8   « VOXECHO1 »
 *   8  version     1   1
 *   9  réservé     3   zéros
 *  12  tailleTrame 4   octets de clair par trame
 *  16  tailleClair 8   longueur totale du clair
 *  24  sel        16   sel de dérivation de la clé du fichier
 *  40  trames…         (nonce 12 | chiffré n | sceau 16)*
 * ```
 *
 * L'en-tête entier et l'indice de la trame entrent dans les données
 * additionnelles authentifiées : une trame ne peut donc être ni déplacée dans
 * le fichier, ni transplantée dans un autre. Sans cela, chaque trame serait
 * authentique isolément et le fichier resterait falsifiable par permutation.
 */

const MAGIE = Buffer.from('VOXECHO1', 'ascii');
const VERSION = 1;
const TAILLE_ENTETE = 40;
const TAILLE_NONCE = 12;
const TAILLE_SCEAU = 16;

/** 64 Kio de clair par trame : quatre trames pour une seconde d'audio du §3. */
export const TAILLE_TRAME_PAR_DEFAUT = 64 * 1024;

/** Longueur d'une clé maître, en octets. AES-256 n'en connaît qu'une. */
export const TAILLE_CLE = 32;

export interface EnteteCoffre {
  version: number;
  tailleTrame: number;
  tailleClair: number;
  sel: Buffer;
}

/**
 * Clé propre au fichier, dérivée de la clé maître et du sel du conteneur.
 *
 * La clé maître ne chiffre jamais directement : deux fichiers ne partagent
 * ainsi aucune clé, et la compromission de l'un n'ouvre pas l'autre.
 * L'identifiant de l'enregistrement entre dans le contexte de dérivation —
 * une trame volée à un autre appel ne se déchiffre pas ici.
 */
export function deriverCle(cleMaitre: Buffer, sel: Buffer, recordingId: string): Buffer {
  if (cleMaitre.length !== TAILLE_CLE) {
    throw new Error(`clé maître de ${TAILLE_CLE} octets attendue`);
  }
  const contexte = `voxecho-record:coffre:v1:${recordingId}`;
  return Buffer.from(hkdfSync('sha256', cleMaitre, sel, contexte, TAILLE_CLE));
}

function entete(tailleTrame: number, tailleClair: number, sel: Buffer): Buffer {
  const tampon = Buffer.alloc(TAILLE_ENTETE);
  MAGIE.copy(tampon, 0);
  tampon.writeUInt8(VERSION, 8);
  tampon.writeUInt32BE(tailleTrame, 12);
  tampon.writeBigUInt64BE(BigInt(tailleClair), 16);
  sel.copy(tampon, 24);
  return tampon;
}

export function lireEntete(tampon: Buffer): EnteteCoffre {
  if (tampon.length < TAILLE_ENTETE) throw new Error('conteneur tronqué : en-tête incomplet');
  if (!tampon.subarray(0, 8).equals(MAGIE)) throw new Error('conteneur non reconnu');
  const version = tampon.readUInt8(8);
  if (version !== VERSION) throw new Error(`version de conteneur inconnue : ${version}`);
  return {
    version,
    tailleTrame: tampon.readUInt32BE(12),
    tailleClair: Number(tampon.readBigUInt64BE(16)),
    sel: Buffer.from(tampon.subarray(24, 40)),
  };
}

/** Un fichier déjà rangé est-il chiffré ? Les anciens ne le sont pas (§9.13). */
export function estConteneur(debut: Buffer): boolean {
  return debut.length >= MAGIE.length && debut.subarray(0, MAGIE.length).equals(MAGIE);
}

/** Données additionnelles authentifiées d'une trame : l'en-tête et son rang. */
function donneesAuthentifiees(entete: Buffer, indice: number): Buffer {
  const rang = Buffer.alloc(4);
  rang.writeUInt32BE(indice);
  return Buffer.concat([entete, rang]);
}

/** Taille sur disque d'une trame dont le clair fait `octets`. */
function tailleTrameChiffree(octets: number): number {
  return TAILLE_NONCE + octets + TAILLE_SCEAU;
}

/**
 * Scelle un clair entier. Le résultat est autonome : en-tête, sel et trames.
 */
export function sceller(
  clair: Buffer,
  cleMaitre: Buffer,
  recordingId: string,
  tailleTrame: number = TAILLE_TRAME_PAR_DEFAUT,
): Buffer {
  const sel = randomBytes(16);
  const cle = deriverCle(cleMaitre, sel, recordingId);
  const tete = entete(tailleTrame, clair.length, sel);

  const morceaux: Buffer[] = [tete];
  const trames = Math.ceil(clair.length / tailleTrame);
  for (let indice = 0; indice < trames; indice += 1) {
    const debut = indice * tailleTrame;
    const tranche = clair.subarray(debut, Math.min(debut + tailleTrame, clair.length));
    const nonce = randomBytes(TAILLE_NONCE);
    const chiffreur = createCipheriv('aes-256-gcm', cle, nonce);
    chiffreur.setAAD(donneesAuthentifiees(tete, indice));
    morceaux.push(nonce, chiffreur.update(tranche), chiffreur.final(), chiffreur.getAuthTag());
  }

  // Un clair vide n'a aucune trame : le conteneur se réduit à son en-tête, et
  // se relit sans cas particulier.
  return Buffer.concat(morceaux);
}

/**
 * Déchiffre une trame lue sur disque. Lève si le sceau ne concorde pas — un
 * octet modifié sur le disque doit se voir, c'est tout l'intérêt de GCM.
 */
function ouvrirTrame(
  trame: Buffer,
  cle: Buffer,
  tete: Buffer,
  indice: number,
  tailleClaire: number,
): Buffer {
  const nonce = trame.subarray(0, TAILLE_NONCE);
  const chiffre = trame.subarray(TAILLE_NONCE, TAILLE_NONCE + tailleClaire);
  const sceau = trame.subarray(TAILLE_NONCE + tailleClaire);
  if (sceau.length !== TAILLE_SCEAU) throw new Error('conteneur tronqué : sceau incomplet');

  const dechiffreur = createDecipheriv('aes-256-gcm', cle, nonce);
  dechiffreur.setAAD(donneesAuthentifiees(tete, indice));
  dechiffreur.setAuthTag(sceau);
  return Buffer.concat([dechiffreur.update(chiffre), dechiffreur.final()]);
}

/** Ouvre un conteneur entier en mémoire. */
export function ouvrir(conteneur: Buffer, cleMaitre: Buffer, recordingId: string): Buffer {
  const tete = conteneur.subarray(0, TAILLE_ENTETE);
  const { tailleTrame, tailleClair, sel } = lireEntete(tete);
  const cle = deriverCle(cleMaitre, sel, recordingId);

  const morceaux: Buffer[] = [];
  const trames = Math.ceil(tailleClair / tailleTrame);
  let curseur = TAILLE_ENTETE;
  for (let indice = 0; indice < trames; indice += 1) {
    const claire = Math.min(tailleTrame, tailleClair - indice * tailleTrame);
    const surDisque = tailleTrameChiffree(claire);
    morceaux.push(
      ouvrirTrame(conteneur.subarray(curseur, curseur + surDisque), cle, tete, indice, claire),
    );
    curseur += surDisque;
  }
  return Buffer.concat(morceaux);
}

/**
 * Flux de clair pour une plage d'octets — c'est ce qui permet au `Range` du §6
 * de survivre au chiffrement. Seules les trames qui recouvrent la plage sont
 * lues et ouvertes ; le reste du fichier n'est jamais touché.
 *
 * `debut` et `fin` sont des positions **dans le clair**, bornes incluses.
 */
export function fluxDeClair(
  chemin: string,
  cleMaitre: Buffer,
  recordingId: string,
  debut: number,
  fin: number,
): Readable {
  return Readable.from(trames(chemin, cleMaitre, recordingId, debut, fin));
}

async function* trames(
  chemin: string,
  cleMaitre: Buffer,
  recordingId: string,
  debut: number,
  fin: number,
): AsyncGenerator<Buffer> {
  let fichier: FileHandle | null = null;
  try {
    fichier = await open(chemin, 'r');

    const tete = Buffer.alloc(TAILLE_ENTETE);
    await fichier.read(tete, 0, TAILLE_ENTETE, 0);
    const { tailleTrame, tailleClair, sel } = lireEntete(tete);
    if (debut > fin || debut < 0 || fin >= tailleClair) return;

    const cle = deriverCle(cleMaitre, sel, recordingId);
    const premiere = Math.floor(debut / tailleTrame);
    const derniere = Math.floor(fin / tailleTrame);

    for (let indice = premiere; indice <= derniere; indice += 1) {
      const claire = Math.min(tailleTrame, tailleClair - indice * tailleTrame);
      const surDisque = tailleTrameChiffree(claire);
      // Toutes les trames sauf la dernière étant pleines, la position d'une
      // trame se calcule : c'est ce qui rend la lecture par plages possible.
      const position = TAILLE_ENTETE + indice * tailleTrameChiffree(tailleTrame);

      const brut = Buffer.alloc(surDisque);
      const { bytesRead } = await fichier.read(brut, 0, surDisque, position);
      if (bytesRead !== surDisque) throw new Error('conteneur tronqué : trame incomplète');

      const clair = ouvrirTrame(brut, cle, tete, indice, claire);
      const offset = indice * tailleTrame;
      yield clair.subarray(Math.max(0, debut - offset), Math.min(clair.length, fin - offset + 1));
    }
  } finally {
    await fichier?.close();
  }
}

/** Taille du clair d'un conteneur, sans le déchiffrer. */
export async function tailleDuClair(chemin: string): Promise<number> {
  const fichier = await open(chemin, 'r');
  try {
    const tete = Buffer.alloc(TAILLE_ENTETE);
    await fichier.read(tete, 0, TAILLE_ENTETE, 0);
    return lireEntete(tete).tailleClair;
  } finally {
    await fichier.close();
  }
}

/** Les premiers octets d'un fichier, pour reconnaître un conteneur. */
export async function premiersOctets(chemin: string, combien = MAGIE.length): Promise<Buffer> {
  const fichier = await open(chemin, 'r');
  try {
    const tampon = Buffer.alloc(combien);
    const { bytesRead } = await fichier.read(tampon, 0, combien, 0);
    return tampon.subarray(0, bytesRead);
  } finally {
    await fichier.close();
  }
}

/** Comparaison à temps constant, pour les vérifications de clé. */
export function memeCle(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
