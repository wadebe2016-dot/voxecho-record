/**
 * Réécoute — CLAUDE.md §6. Le lecteur du portail est un `<audio>` : il
 * réclame le fichier lui-même, par requêtes `Range` successives, et n'a
 * aucun moyen d'y joindre l'en-tête `Authorization` du portail.
 *
 * L'écoute s'ouvre donc en deux temps. Le portail demande un **billet**
 * d'écoute avec son jeton habituel — c'est cet acte, et lui seul, qui est
 * consigné au journal (`AuditEvent LISTEN`). Le billet, court et limité à un
 * seul enregistrement, accompagne ensuite chaque requête du lecteur.
 *
 * Le journal compte ainsi une entrée par écoute, non par requête HTTP : un
 * appel de dix minutes en produit une, pas les trente que le navigateur
 * envoie pour le charger et s'y déplacer.
 */
export interface ListenTicketResponse {
  /** À passer en paramètre `ticket` de `GET /api/recordings/:id/audio`. */
  ticket: string;
  /** Validité du billet, telle qu'écrite dans la configuration (ex. « 30m »). */
  expiresIn: string;
}
