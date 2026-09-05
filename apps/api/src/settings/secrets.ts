import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Secrets de réglage, chiffrés au repos — CLAUDE.md §9.36.
 *
 * La clé maître ne chiffre jamais directement : on en dérive une clé propre aux
 * réglages, sous un contexte qui n'est celui d'aucun autre usage. Employer la
 * clé maître telle quelle aurait lié deux sujets sans rapport — une rotation de
 * clé de coffre aurait rendu du même coup l'annuaire injoignable et la
 * supervision muette.
 */

const TAILLE_CLE = 32;
const TAILLE_NONCE = 12;
const CONTEXTE = 'voxecho-record:reglages:v1';

/** Marqueur qui distingue un conteneur de secret d'une valeur ordinaire. */
export const PREFIXE_SECRET = 'vxs1:';

/** Ce que l'api rend à la place d'un secret. Jamais la valeur. */
export const SECRET_MASQUE = '********';

/** Un secret tel qu'il vit dans le JSON d'une section. */
export interface SecretChiffre {
  chiffre: string;
}

export function estSecretChiffre(valeur: unknown): valeur is SecretChiffre {
  return (
    typeof valeur === 'object' &&
    valeur !== null &&
    typeof (valeur as SecretChiffre).chiffre === 'string' &&
    (valeur as SecretChiffre).chiffre.startsWith(PREFIXE_SECRET)
  );
}

function deriverCleReglages(cleMaitre: Buffer): Buffer {
  if (cleMaitre.length !== TAILLE_CLE) {
    throw new Error(`clé maître de ${TAILLE_CLE} octets attendue`);
  }
  return Buffer.from(hkdfSync('sha256', cleMaitre, Buffer.alloc(0), CONTEXTE, TAILLE_CLE));
}

/** Chiffre un secret. Le nonce est tiré à chaque écriture, jamais réutilisé. */
export function chiffrerSecret(cleMaitre: Buffer, clair: string): SecretChiffre {
  const cle = deriverCleReglages(cleMaitre);
  const nonce = randomBytes(TAILLE_NONCE);
  const chiffreur = createCipheriv('aes-256-gcm', cle, nonce);
  const corps = Buffer.concat([chiffreur.update(clair, 'utf8'), chiffreur.final()]);
  const sceau = chiffreur.getAuthTag();
  return {
    chiffre: `${PREFIXE_SECRET}${Buffer.concat([nonce, sceau, corps]).toString('base64')}`,
  };
}

export function dechiffrerSecret(cleMaitre: Buffer, secret: SecretChiffre): string {
  const brut = Buffer.from(secret.chiffre.slice(PREFIXE_SECRET.length), 'base64');
  const nonce = brut.subarray(0, TAILLE_NONCE);
  const sceau = brut.subarray(TAILLE_NONCE, TAILLE_NONCE + 16);
  const corps = brut.subarray(TAILLE_NONCE + 16);
  const dechiffreur = createDecipheriv('aes-256-gcm', deriverCleReglages(cleMaitre), nonce);
  dechiffreur.setAuthTag(sceau);
  return Buffer.concat([dechiffreur.update(corps), dechiffreur.final()]).toString('utf8');
}

/**
 * Remplace tout secret par son masque, en profondeur.
 *
 * C'est ce qui sort de l'api, et c'est aussi ce qui entre au journal d'audit :
 * un avant/après de réglage ne doit jamais faire voyager un mot de passe de
 * liaison, même vers une table que personne ne peut modifier.
 */
export function masquerSecrets(valeur: unknown): unknown {
  if (estSecretChiffre(valeur)) return SECRET_MASQUE;
  if (Array.isArray(valeur)) return valeur.map(masquerSecrets);
  if (valeur !== null && typeof valeur === 'object') {
    return Object.fromEntries(
      Object.entries(valeur as Record<string, unknown>).map(([cle, v]) => [cle, masquerSecrets(v)]),
    );
  }
  return valeur;
}

/** Y a-t-il au moins un secret quelque part dans cette section ? */
export function porteUnSecret(valeur: unknown): boolean {
  if (estSecretChiffre(valeur)) return true;
  if (Array.isArray(valeur)) return valeur.some(porteUnSecret);
  if (valeur !== null && typeof valeur === 'object') {
    return Object.values(valeur as Record<string, unknown>).some(porteUnSecret);
  }
  return false;
}
