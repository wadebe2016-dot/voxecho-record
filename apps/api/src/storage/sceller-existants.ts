import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { resoudreCheminDeDonnees } from '../config/chemins';
import { estConteneur, sceller, TAILLE_CLE } from './coffre';
import { appliquerDatabaseUrl } from '../config/database-url';

/**
 * Scelle les pièces déjà rangées en clair — CLAUDE.md §9.13.
 *
 * Le chiffrement s'introduit progressivement : activer `STORAGE_ENCRYPTION_ENABLED`
 * ne concerne que les pièces à venir, et l'api sait lire les deux formats. Cette
 * commande rattrape l'existant, un fichier à la fois, sans jamais interrompre le
 * service.
 *
 * Simulation par défaut. Rien n'est écrit sans `--appliquer` : une commande qui
 * réécrit des preuves ne doit pas pouvoir partir d'une faute de frappe.
 *
 *   pnpm --filter @voxecho/api exec dotenv -e ../../.env -- \
 *     tsx src/storage/sceller-existants.ts [--appliquer] [--locataire <slug>]
 */

interface Options {
  appliquer: boolean;
  locataire: string | null;
}

function lireOptions(argv: string[]): Options {
  const locataireIndex = argv.indexOf('--locataire');
  return {
    appliquer: argv.includes('--appliquer'),
    locataire: locataireIndex === -1 ? null : (argv[locataireIndex + 1] ?? null),
  };
}

async function main(): Promise<void> {
  // Le point d'entrée de l'image construit DATABASE_URL ; une commande
  // d'exploitation le court-circuite et doit donc la construire aussi (§9.19).
  appliquerDatabaseUrl();
  const options = lireOptions(process.argv.slice(2));
  const prisma = new PrismaClient();

  const brut = process.env.STORAGE_MASTER_KEY ?? '';
  const cleMaitre = Buffer.from(brut, 'base64');
  if (cleMaitre.length !== TAILLE_CLE) {
    throw new Error(
      `STORAGE_MASTER_KEY absente ou de mauvaise taille : ${TAILLE_CLE} octets en base64 attendus.`,
    );
  }
  const reference = process.env.STORAGE_KEY_REF ?? 'k1';
  const storageDir = resoudreCheminDeDonnees(process.env.STORAGE_DIR ?? './data/storage');

  const aSceller = await prisma.recording.findMany({
    where: {
      encrypted: false,
      status: { in: ['stored', 'archived'] },
      ...(options.locataire ? { tenant: { slug: options.locataire } } : {}),
    },
    select: { id: true, filePath: true, sha256: true, tenantId: true },
    orderBy: { createdAt: 'asc' },
  });

  console.warn(
    `${aSceller.length} pièce(s) en clair${options.locataire ? ` chez « ${options.locataire} »` : ''}` +
      `${options.appliquer ? '' : ' — simulation, rien ne sera écrit'}`,
  );

  let scellees = 0;
  let deja = 0;
  const incidents: string[] = [];

  for (const recording of aSceller) {
    const chemin = resolve(join(storageDir, recording.filePath));
    try {
      const contenu = await readFile(chemin);

      if (estConteneur(contenu)) {
        // La base dit « en clair », le disque dit le contraire : on ne touche
        // à rien et on le signale. Rechiffrer un conteneur le rendrait
        // illisible.
        incidents.push(`${recording.filePath} : déjà scellé sur le disque, base non à jour`);
        deja += 1;
        continue;
      }

      // L'empreinte est vérifiée avant de réécrire : on ne scelle pas une
      // pièce déjà altérée, sans quoi on figerait l'altération sous un sceau
      // qui la rendrait ensuite « authentique ».
      const empreinte = createHash('sha256').update(contenu).digest('hex');
      if (empreinte !== recording.sha256) {
        incidents.push(
          `${recording.filePath} : empreinte divergente (base ${recording.sha256}, disque ${empreinte}) — NON scellée`,
        );
        continue;
      }

      if (!options.appliquer) {
        scellees += 1;
        continue;
      }

      const conteneur = sceller(contenu, cleMaitre, recording.id);
      const provisoire = `${chemin}.coffre`;
      await writeFile(provisoire, conteneur);
      await rename(provisoire, chemin);
      await prisma.recording.update({
        where: { id: recording.id },
        data: { encrypted: true, keyRef: reference },
      });
      scellees += 1;
    } catch (erreur) {
      incidents.push(
        `${recording.filePath} : ${erreur instanceof Error ? erreur.message : String(erreur)}`,
      );
    }
  }

  console.warn(
    `${options.appliquer ? 'Scellées' : 'À sceller'} : ${scellees} · déjà scellées : ${deja} · incidents : ${incidents.length}`,
  );
  for (const incident of incidents) console.warn(`  ! ${incident}`);
  if (!options.appliquer && scellees > 0) {
    console.warn('Relancer avec --appliquer pour écrire.');
  }

  await prisma.$disconnect();
  // Un incident ne doit pas passer pour un succès dans un enchaînement de
  // commandes d'exploitation.
  process.exitCode = incidents.length > 0 ? 1 : 0;
}

void main().catch((erreur: unknown) => {
  console.error(erreur);
  process.exitCode = 1;
});
