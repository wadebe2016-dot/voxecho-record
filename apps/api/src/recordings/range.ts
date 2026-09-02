/**
 * En-tête `Range` du client — RFC 9110 §14.
 *
 * Un lecteur audio ne télécharge pas un fichier : il en réclame des morceaux,
 * au fil de l'écoute et des déplacements dans la piste. Safari va plus loin
 * et refuse de lire une source qui ne sait pas répondre par un `206` en
 * bonne et due forme dès sa requête sonde.
 *
 * Fonction pure, testée à part : c'est la pièce où une erreur d'un octet ne
 * se voit pas à l'œil nu.
 */

export interface Plage {
  /** Premier octet servi, inclus. */
  debut: number;
  /** Dernier octet servi, inclus. */
  fin: number;
}

export type Demande =
  { type: 'complet' } | { type: 'partiel'; plage: Plage } | { type: 'insatisfiable' };

const UNE_PLAGE = /^bytes=(\d*)-(\d*)$/;

export function analyserRange(entete: string | undefined, taille: number): Demande {
  if (entete === undefined || entete.trim() === '') return { type: 'complet' };

  // Plusieurs plages en une requête : la RFC autorise à ignorer l'en-tête, ce
  // qui vaut mieux que de fabriquer un multipart que personne ne demande.
  const match = UNE_PLAGE.exec(entete.trim());
  if (!match) return { type: 'complet' };

  const [, brutDebut = '', brutFin = ''] = match;
  if (brutDebut === '' && brutFin === '') return { type: 'complet' };

  // Un fichier vide n'a aucun octet à offrir : toute plage est insatisfiable.
  if (taille === 0) return { type: 'insatisfiable' };

  if (brutDebut === '') {
    // `bytes=-N` : les N derniers octets. `bytes=-0` ne désigne rien.
    const suffixe = Number(brutFin);
    if (suffixe === 0) return { type: 'insatisfiable' };
    return { type: 'partiel', plage: { debut: Math.max(0, taille - suffixe), fin: taille - 1 } };
  }

  const debut = Number(brutDebut);
  if (debut >= taille) return { type: 'insatisfiable' };

  // `bytes=S-` : jusqu'au bout. Une fin au-delà du fichier est ramenée au
  // dernier octet plutôt que refusée — c'est ce qu'attendent les lecteurs.
  const fin = brutFin === '' ? taille - 1 : Math.min(Number(brutFin), taille - 1);
  if (fin < debut) return { type: 'insatisfiable' };

  return { type: 'partiel', plage: { debut, fin } };
}
