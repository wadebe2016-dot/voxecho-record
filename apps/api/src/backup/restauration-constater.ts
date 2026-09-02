import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { resoudreCheminDeDonnees } from '../config/chemins';
import { analyserArguments } from './arguments';
import { lignesDe } from './constat';
import { lireManifeste, NOM_INVENTAIRE, NOM_MANIFESTE } from './manifeste';
import { verifierBaseRestauree, type RapportBaseRestauree } from './base-restauree';

/**
 * Constate une base restaurée — CLAUDE.md §9.15.
 *
 *   pnpm --filter @voxecho/api run restauration:constater [<répertoire de prise>]
 *
 * S'exécute **sur la machine restaurée**, contre la base que désigne sa
 * `DATABASE_URL` : c'est ce qui la distingue de `sauvegarde:verifier`, qui ne
 * regarde que la prise et le stockage. Elle demande à la base ce que le
 * manifeste et l'inventaire disent devoir s'y trouver, et le dit avant que
 * l'exploitant ne quitte sa console.
 *
 * Sortie non nulle dès qu'un écart est constaté.
 */

async function dernierePrise(racine: string): Promise<string> {
  const entrees = await readdir(racine, { withFileTypes: true });
  const prises = entrees
    .filter((entree) => entree.isDirectory())
    .map((entree) => entree.name)
    .sort();
  const derniere = prises.at(-1);
  if (!derniere) throw new Error(`Aucune sauvegarde dans ${racine}.`);
  return join(racine, derniere);
}

function afficher(rapport: RapportBaseRestauree, repertoire: string): void {
  console.warn(`Base constatée : ${rapport.cible}`);
  console.warn(`  d’après      : ${repertoire}`);
  console.warn(
    `  migrations   : ${rapport.migration.etat} — ${rapport.migration.appliquees} en base, ` +
      `${rapport.migration.attendues} à la prise (dernière « ${rapport.migration.trouvee ?? 'aucune'} »)`,
  );
  console.warn(
    `  locataires   : ${rapport.locataires.trouves} en base, ${rapport.locataires.attendus} attendu(s)`,
  );
  for (const ligne of lignesDe(rapport.locataires.divergents, 'écart')) console.warn(ligne);
  console.warn(
    `  enregistr.   : ${rapport.pieces.retrouvees}/${rapport.pieces.attendues} retrouvé(s) à l’identique` +
      `${rapport.pieces.enTrop > 0 ? `, ${rapport.pieces.enTrop} en trop` : ''}`,
  );
  for (const ligne of lignesDe(rapport.pieces.absentes, 'absent')) console.warn(ligne);
  for (const ligne of lignesDe(rapport.pieces.divergentes, 'divergent')) console.warn(ligne);

  console.warn('');
  if (rapport.fidele) {
    console.warn('La base restaurée rend exactement ce que la prise annonçait.');
    // La base seule ne fait pas une restauration : sans les fichiers, elle
    // ne rend que des fiches, et sans la clé elle ne rend rien d'audible.
    console.warn('Reste à constater le stockage et la clé : `sauvegarde:verifier --stockage`.');
  } else {
    for (const anomalie of rapport.anomalies) console.warn(`! ${anomalie}`);
  }
}

async function main(): Promise<void> {
  const arguments_ = analyserArguments(process.argv.slice(2), [], []);
  const racine = resoudreCheminDeDonnees(process.env.BACKUP_DIR ?? './data/backups');
  const positionnel = arguments_.positionnels[0];
  const repertoire = positionnel
    ? resoudreCheminDeDonnees(positionnel)
    : await dernierePrise(racine);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL absente : voir .env.example.');

  const manifeste = lireManifeste(await readFile(join(repertoire, NOM_MANIFESTE), 'utf8'));
  const prisma = new PrismaClient();
  try {
    const rapport = await verifierBaseRestauree({
      prisma,
      manifeste,
      cheminInventaire: join(repertoire, manifeste.stockage.fichier || NOM_INVENTAIRE),
      cible: databaseUrl,
    });
    afficher(rapport, repertoire);
    process.exitCode = rapport.fidele ? 0 : 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((erreur: unknown) => {
  console.error(erreur instanceof Error ? erreur.message : erreur);
  process.exitCode = 1;
});
