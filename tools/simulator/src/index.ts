import { resolve } from 'node:path';
import { AIDE, parseOptions } from './options';
import { simuler } from './simulate';
import type { Depot } from './deposit';

/**
 * Point d'entrée du simulateur — CLAUDE.md §4.
 *
 * Il ne connaît que le contrat §3 : il écrit des fichiers dans INGEST_DIR et
 * s'arrête là. Aucune connexion à la base, aucun appel à l'api — c'est ce qui
 * fait de lui un substitut honnête de la téléphonie, et ce qui garantit qu'en
 * S5 le remplacer par FreeSWITCH ne changera rien au portail.
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.warn(AIDE);
    return 0;
  }

  const resultat = parseOptions(argv, process.env);
  if (!resultat.ok) {
    console.error(`Arguments invalides :\n${resultat.errors.map((e) => `  - ${e}`).join('\n')}\n`);
    console.error(AIDE);
    return 2;
  }

  const options = { ...resultat.value, ingestDir: resolve(resultat.value.ingestDir) };
  const debut = Date.now();

  console.warn(
    [
      `Simulateur VoxEcho — mode ${options.mode}`,
      `  dépôt      : ${options.ingestDir}/<slug>/`,
      `  locataires : ${options.tenants.join(', ')}`,
      `  graine     : ${options.seed}`,
      options.corrupt ? '  avaries    : oui (ces dépôts doivent finir en quarantaine)' : '',
      options.mode === 'continuous'
        ? `  cadence    : ${options.rate}/min — Ctrl+C pour arrêter`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  // Ctrl+C laisse le dépôt en cours se terminer : couper entre le wav et le
  // json fabriquerait une fausse anomalie que l'ingestion mettrait en
  // quarantaine, et le simulateur mentirait sur ce qu'il a produit.
  let interrompu = false;
  process.on('SIGINT', () => {
    if (interrompu) process.exit(130);
    interrompu = true;
    console.warn('\nArrêt demandé : le dépôt en cours se termine…');
  });

  const depots = await simuler({
    options,
    arret: () => interrompu,
    journal: {
      depot: (depot: Depot, index: number, total: number | null) => {
        const compteur = total === null ? `${index + 1}` : `${index + 1}/${total}`;
        const avarie = depot.avarie ? ` [${depot.avarie}]` : '';
        console.warn(
          `  ${compteur}  ${depot.slug}  ${depot.appel.radical}  ` +
            `${depot.appel.metadata.durationSec}s  ${(depot.octets / 1024).toFixed(0)} Kio${avarie}`,
        );
      },
    },
  });

  const secondes = ((Date.now() - debut) / 1000).toFixed(1);
  const octets = depots.reduce((somme, depot) => somme + depot.octets, 0);
  console.warn(
    `\n${depots.length} appel(s) déposé(s) en ${secondes} s — ${(octets / 1_048_576).toFixed(1)} Mio.`,
  );
  if (options.corrupt) {
    console.warn("Ces dépôts sont avariés : l'ingestion doit tous les mettre en quarantaine.");
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('Simulateur interrompu :', error);
    process.exit(1);
  });
