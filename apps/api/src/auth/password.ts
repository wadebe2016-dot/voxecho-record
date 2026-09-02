import * as argon2 from 'argon2';

/**
 * Hachage des mots de passe en Argon2id, paramètres alignés sur les
 * recommandations OWASP (19 MiB, 2 passes, parallélisme 1).
 */
const OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

/** Vérifie un mot de passe. Un hachage corrompu répond `false`, sans lever. */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
