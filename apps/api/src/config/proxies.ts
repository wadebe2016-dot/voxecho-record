/**
 * Confiance accordée aux proxys — CLAUDE.md §9.16.
 *
 * Le journal d'audit inscrit l'adresse du demandeur (§5). Derrière le nginx
 * du livrable, `request.ip` vaut l'adresse du conteneur qui relaie : toutes
 * les entrées portaient donc la même adresse, celle du proxy, et le champ
 * `ip` ne disait plus rien. Express sait lire `X-Forwarded-For`, mais
 * seulement si on le lui demande.
 *
 * Le lui demander sans réserve serait pire : cet en-tête est écrit par le
 * client. N'importe qui inscrirait alors l'adresse de son choix dans un
 * journal append-only qu'aucune route ne peut corriger, et se rendrait
 * invisible d'une limitation par adresse. La confiance est donc **nominative**
 * — on désigne les relais qu'on a soi-même installés — et vide par défaut.
 */

/** Ce qu'attend `app.set('trust proxy', …)` : `false`, ou la liste déclarée. */
export function confianceProxy(brut: string): false | string[] {
  const declares = brut
    .split(',')
    .map((valeur) => valeur.trim())
    .filter((valeur) => valeur.length > 0);
  // Aucun proxy déclaré : on ne croit que la socket. C'est le cas d'une api
  // exposée directement, et c'est le défaut le plus sûr.
  return declares.length === 0 ? false : declares;
}
