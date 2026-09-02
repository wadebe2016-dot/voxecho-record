import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { resoudreCheminDeDonnees } from '../config/chemins';
import { TAILLE_CLE } from '../storage/coffre';
import { analyserArguments } from './arguments';
import { creerSauvegarde } from './sauvegarde.service';
import { NOM_MANIFESTE } from './manifeste';

/**
 * Prend une sauvegarde — CLAUDE.md §9.14.
 *
 *   pnpm --filter @voxecho/api run sauvegarde:creer [--vers <répertoire>]
 *
 * Produit un répertoire daté contenant le dump de la base, l'inventaire du
 * stockage et le manifeste qui les relie. Les pièces audio ne sont pas
 * recopiées : leur copie relève de l'exploitant, et l'inventaire est ce qui
 * permettra de prouver qu'elle est complète.
 *
 * L'empreinte du manifeste s'affiche en fin d'exécution : la consigner hors
 * de la sauvegarde est ce qui permettra, plus tard, de démontrer que la prise
 * n'a pas été retouchée entre-temps.
 */

function lireVersion(): string {
  try {
    const brut = readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8');
    return (JSON.parse(brut) as { version?: string }).version ?? 'inconnue';
  } catch {
    return 'inconnue';
  }
}

async function main(): Promise<void> {
  const arguments_ = analyserArguments(process.argv.slice(2), ['--vers'], []);
  const prisma = new PrismaClient();

  const destination = resoudreCheminDeDonnees(
    arguments_.valeurs.get('--vers') ?? process.env.BACKUP_DIR ?? './data/backups',
  );
  const storageDir = resoudreCheminDeDonnees(process.env.STORAGE_DIR ?? './data/storage');
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL absente : voir .env.example.');

  const brut = process.env.STORAGE_MASTER_KEY ?? '';
  const cleMaitre = brut === '' ? null : Buffer.from(brut, 'base64');
  if (cleMaitre !== null && cleMaitre.length !== TAILLE_CLE) {
    throw new Error(
      `STORAGE_MASTER_KEY de mauvaise taille : ${TAILLE_CLE} octets en base64 attendus.`,
    );
  }

  const sauvegarde = await creerSauvegarde({
    prisma,
    destination,
    storageDir,
    databaseUrl,
    cleMaitre,
    version: lireVersion(),
  });

  const { manifeste } = sauvegarde;
  console.warn(`Sauvegarde écrite dans ${sauvegarde.repertoire}`);
  console.warn(
    `  base       : ${manifeste.base.octets} octets, schéma « ${manifeste.base.schemaPostgres} », ` +
      `${manifeste.base.migrationsAppliquees} migration(s), dernière « ${manifeste.base.derniereMigration ?? 'aucune'} »`,
  );
  console.warn(
    `  stockage   : ${manifeste.stockage.pieces} pièce(s) inventoriée(s) — ` +
      `${manifeste.stockage.scellees} scellée(s), ${manifeste.stockage.enClair} en clair, ` +
      `${manifeste.stockage.purgees} purgée(s) ; ${manifeste.stockage.octetsClair} octets de clair`,
  );
  console.warn(
    `  clé maître : ${manifeste.cleMaitre.empreinte ?? 'aucune configurée'}` +
      `${manifeste.stockage.cles.length > 0 ? ` — clés utilisées : ${manifeste.stockage.cles.join(', ')}` : ''}`,
  );
  console.warn('');
  console.warn(`Empreinte de ${NOM_MANIFESTE} : ${sauvegarde.empreinte}`);
  console.warn(
    'La consigner hors de la sauvegarde, et vérifier la prise avec ' +
      '`sauvegarde:verifier --empreinte <valeur>`.',
  );
  if (manifeste.stockage.scellees > 0) {
    console.warn(
      'Les pièces scellées ne se rouvrent qu’avec la clé maître, qui n’est PAS ' +
        'dans cette sauvegarde : la conserver ailleurs, et la sauvegarder aussi.',
    );
  }
  console.warn(
    'Les fichiers audio ne sont pas recopiés ici : sauvegarder ' +
      `${manifeste.stockage.racine} par les moyens habituels, puis vérifier avec --stockage.`,
  );

  await prisma.$disconnect();
}

void main().catch((erreur: unknown) => {
  console.error(erreur instanceof Error ? erreur.message : erreur);
  process.exitCode = 1;
});
