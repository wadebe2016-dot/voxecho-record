import type { Role } from '@prisma/client';

/**
 * Comptes du jeu d'évaluation — CLAUDE.md §9.18 et §9.21.
 *
 * Ils vivent sur une instance publique. Un mot de passe écrit dans le dépôt,
 * ou laissé à une valeur d'exemple, y serait une porte ouverte sur un portail
 * qui affiche un journal d'audit et sert des fichiers audio — et la première
 * évaluation faite par un client se ferait sur une instance que n'importe qui
 * a pu visiter avant lui.
 *
 * La règle est donc la même que pour la validation d'environnement du §2 :
 * mieux vaut ne pas créer le compte que d'en créer un que tout le monde
 * devine.
 */

export interface CompteEvaluation {
  role: Role;
  email: string;
  motDePasse: string;
}

/** Longueur minimale d'un mot de passe d'évaluation. */
export const LONGUEUR_MINIMALE = 12;

/** Valeurs qu'on trouve dans un fichier d'exemple, et qui n'en sont pas. */
const REFUSES = ['changeme', 'motdepasse', 'password', 'demo!2026', 'voxecho'];

export function compteEvaluation(
  role: Role,
  prefixe: string,
  emailParDefaut: string,
  env: NodeJS.ProcessEnv,
): CompteEvaluation {
  const email = env[`${prefixe}_EMAIL`]?.trim() || emailParDefaut;
  const motDePasse = env[`${prefixe}_PASSWORD`]?.trim() ?? '';

  if (motDePasse.length < LONGUEUR_MINIMALE) {
    throw new Error(
      `${prefixe}_PASSWORD : au moins ${LONGUEUR_MINIMALE} caractères attendus. ` +
        'Des identifiants devinables sur une instance publique sont une porte ouverte.',
    );
  }
  if (REFUSES.some((refuse) => motDePasse.toLowerCase().includes(refuse))) {
    throw new Error(
      `${prefixe}_PASSWORD : mot de passe d'exemple non remplacé (openssl rand -base64 18).`,
    );
  }
  return { role, email, motDePasse };
}
