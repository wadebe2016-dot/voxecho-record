import { randomInt } from 'node:crypto';

/**
 * Politique de mot de passe — CLAUDE.md §9.26.
 *
 * Une longueur sérieuse, et le refus de ce qui se devine. **Pas d'expiration
 * périodique** : imposer un changement tous les trois mois produit
 * `Banque2026!1`, puis `Banque2026!2`, et des pense-bêtes sous les claviers —
 * les recommandations actuelles l'ont abandonnée, et un responsable conformité
 * qui s'attendrait à l'inverse trouvera ici la raison.
 *
 * Ce qui protège vraiment est ailleurs, et déjà en place : verrouillage après
 * échecs (§5), limitation par adresse (§9.16), et mot de passe provisoire à
 * renouveler dès la première connexion.
 */

/** Ce qu'on refuse, quelle que soit la longueur. */
const SUITES = ['123456', 'azerty', 'qwerty', 'motdepasse', 'password', 'voxecho', 'changeme'];

export interface VerdictMotDePasse {
  ok: boolean;
  erreurs: string[];
}

export function verifierMotDePasse(
  motDePasse: string,
  options: { longueurMinimale: number; email?: string },
): VerdictMotDePasse {
  const erreurs: string[] = [];
  const minuscule = motDePasse.toLowerCase();

  if (motDePasse.length < options.longueurMinimale) {
    erreurs.push(`Au moins ${options.longueurMinimale} caractères.`);
  }
  if (SUITES.some((suite) => minuscule.includes(suite))) {
    erreurs.push('Trop proche d’un mot de passe courant.');
  }

  const identifiant = options.email?.split('@')[0]?.toLowerCase();
  if (identifiant !== undefined && identifiant.length >= 3 && minuscule.includes(identifiant)) {
    // Un mot de passe qui contient l'adresse de son propriétaire se devine
    // depuis la seule liste des comptes.
    erreurs.push('Ne doit pas contenir votre adresse électronique.');
  }

  if (new Set(motDePasse).size < 5) {
    erreurs.push('Trop peu de caractères distincts.');
  }

  return { ok: erreurs.length === 0, erreurs };
}

/**
 * Mot de passe provisoire, lisible à voix haute et sans caractère ambigu :
 * il est transmis de vive voix ou par un canal de fortune, et il ne servira
 * qu'une fois — le compte doit le renouveler à la première connexion.
 */
export function motDePasseProvisoire(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const groupes: string[] = [];
  for (let groupe = 0; groupe < 4; groupe += 1) {
    let bloc = '';
    for (let position = 0; position < 4; position += 1) {
      bloc += alphabet[randomInt(0, alphabet.length)];
    }
    groupes.push(bloc);
  }
  return groupes.join('-');
}
