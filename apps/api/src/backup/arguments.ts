/**
 * Analyse des arguments des commandes de sauvegarde — CLAUDE.md §9.14.
 *
 * Un parcours naïf prend la valeur d'une option pour un argument positionnel :
 * `--empreinte <sha256>` faisait chercher une sauvegarde dans un répertoire
 * nommé d'après l'empreinte. Et une option mal orthographiée — `--stockages`
 * — passerait pour un mot inconnu ignoré, laissant croire que le stockage a
 * été vérifié alors qu'il ne l'a pas été. Une commande d'exploitation qui
 * fait moins que ce qu'on lui a demandé, sans le dire, est pire qu'une
 * commande qui refuse de partir.
 */

export interface Arguments {
  positionnels: string[];
  valeurs: Map<string, string>;
  drapeaux: Set<string>;
}

export function analyserArguments(
  argv: string[],
  aValeur: readonly string[],
  drapeauxConnus: readonly string[],
): Arguments {
  const attenduAvecValeur = new Set(aValeur);
  const attenduSansValeur = new Set(drapeauxConnus);
  const resultat: Arguments = { positionnels: [], valeurs: new Map(), drapeaux: new Set() };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    // `pnpm run … -- --stockage` transmet le séparateur tel quel.
    if (argument === '--') continue;

    if (!argument.startsWith('--')) {
      resultat.positionnels.push(argument);
      continue;
    }
    if (attenduAvecValeur.has(argument)) {
      const valeur = argv[index + 1];
      if (valeur === undefined || valeur.startsWith('--')) {
        throw new Error(`L’option ${argument} attend une valeur.`);
      }
      resultat.valeurs.set(argument, valeur);
      index += 1;
      continue;
    }
    if (attenduSansValeur.has(argument)) {
      resultat.drapeaux.add(argument);
      continue;
    }
    throw new Error(
      `Option inconnue : ${argument}. Attendues : ${[...attenduAvecValeur, ...attenduSansValeur].sort().join(', ')}.`,
    );
  }
  return resultat;
}
