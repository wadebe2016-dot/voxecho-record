import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { PrismaClient } from '@prisma/client';
import { empreinteCleMaitre } from '../storage/coffre';
import {
  empreinteDe,
  NOM_DUMP,
  NOM_INVENTAIRE,
  NOM_MANIFESTE,
  NOTE_CLE_MAITRE,
  serialiserManifeste,
  type Manifeste,
} from './manifeste';
import { serialiserLigne, type LigneInventaire } from './inventaire';
import { cibleDepuisUrl, pgDump, type Dumper } from './pg-dump';

/**
 * Sauvegarde et vérification de restauration — CLAUDE.md §9.14.
 *
 * Une sauvegarde de VoxEcho Record tient en trois pièces qui ne valent que
 * réunies : le dump de la base, l'inventaire du stockage, et la clé maître —
 * qui, elle, n'est pas ici et ne doit jamais y être. Le manifeste est ce qui
 * les relie : il dit ce qui a été pris, et reconnaît la clé qu'il faut avoir
 * gardée ailleurs.
 */

/** Lot de lecture de la base : ni un aller-retour par pièce, ni tout d'un coup. */
const LOT = 500;

export interface OptionsSauvegarde {
  prisma: PrismaClient;
  /** Répertoire racine où déposer la sauvegarde (`BACKUP_DIR`). */
  destination: string;
  storageDir: string;
  databaseUrl: string;
  /** Clé maître en service, pour n'en retenir que l'empreinte. */
  cleMaitre: Buffer | null;
  version: string;
  dumper?: Dumper;
  maintenant?: Date;
}

export interface Sauvegarde {
  repertoire: string;
  manifeste: Manifeste;
  /** Empreinte du manifeste lui-même : à consigner hors de la sauvegarde. */
  empreinte: string;
}

/** Nom du répertoire d'une prise : trié chronologiquement, sans ambiguïté. */
export function nomDePrise(quand: Date): string {
  return `${quand.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}Z`;
}

async function empreinteDuFlux(flux: Readable): Promise<{ sha256: string; octets: number }> {
  const hachage = createHash('sha256');
  let octets = 0;
  for await (const morceau of flux) {
    const bloc = morceau as Buffer;
    octets += bloc.length;
    hachage.update(bloc);
  }
  return { sha256: hachage.digest('hex'), octets };
}

async function empreinteDuFichier(chemin: string): Promise<{ sha256: string; octets: number }> {
  return empreinteDuFlux(createReadStream(chemin));
}

/**
 * Écrit l'inventaire en flux et rend ce qu'il faut au manifeste. Les pièces
 * purgées y figurent : leur ligne subsiste en base (§9.7), et une
 * restauration doit pouvoir constater qu'aucun fichier n'est attendu pour
 * elles — un fichier revenu à cette place serait un incident.
 */
async function ecrireInventaire(
  prisma: PrismaClient,
  chemin: string,
): Promise<{
  sha256: string;
  pieces: number;
  octetsClair: number;
  scellees: number;
  enClair: number;
  purgees: number;
  cles: string[];
  parLocataire: Map<string, number>;
}> {
  const sortie = createWriteStream(chemin, { encoding: 'utf8' });
  const hachage = createHash('sha256');
  const cles = new Set<string>();
  const parLocataire = new Map<string, number>();
  let pieces = 0;
  let octetsClair = 0;
  let scellees = 0;
  let enClair = 0;
  let purgees = 0;

  try {
    let curseur: string | undefined;
    for (;;) {
      const lot = await prisma.recording.findMany({
        take: LOT,
        ...(curseur ? { skip: 1, cursor: { id: curseur } } : {}),
        orderBy: { id: 'asc' },
        select: {
          id: true,
          tenantId: true,
          filePath: true,
          sha256: true,
          sizeBytes: true,
          status: true,
          encrypted: true,
          keyRef: true,
        },
      });
      if (lot.length === 0) break;

      for (const piece of lot) {
        const ligne: LigneInventaire = {
          id: piece.id,
          tenantId: piece.tenantId,
          chemin: piece.filePath,
          sha256: piece.sha256,
          octets: Number(piece.sizeBytes),
          statut: piece.status,
          scellee: piece.encrypted,
          cle: piece.keyRef,
        };
        const brut = serialiserLigne(ligne);
        hachage.update(brut);
        if (!sortie.write(brut)) {
          await new Promise<void>((resoudre) => sortie.once('drain', () => resoudre()));
        }

        pieces += 1;
        parLocataire.set(piece.tenantId, (parLocataire.get(piece.tenantId) ?? 0) + 1);
        if (piece.status === 'purged') {
          purgees += 1;
        } else {
          octetsClair += ligne.octets;
          if (piece.encrypted) scellees += 1;
          else enClair += 1;
        }
        if (piece.keyRef) cles.add(piece.keyRef);
      }

      curseur = lot[lot.length - 1]?.id;
    }
  } finally {
    await new Promise<void>((resoudre, rejeter) => {
      sortie.end((erreur?: Error) => (erreur ? rejeter(erreur) : resoudre()));
    });
  }

  return {
    sha256: hachage.digest('hex'),
    pieces,
    octetsClair,
    scellees,
    enClair,
    purgees,
    cles: [...cles].sort(),
    parLocataire,
  };
}

interface MigrationPrisma {
  migration_name: string;
}

export async function etatDesMigrations(
  prisma: PrismaClient,
): Promise<{ derniere: string | null; total: number }> {
  // La restauration devra présenter une base au même point : une migration
  // manquante ne se voit pas, elle se constate en panne des mois plus tard.
  const lignes = await prisma.$queryRawUnsafe<MigrationPrisma[]>(
    'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at ASC',
  );
  return { derniere: lignes.at(-1)?.migration_name ?? null, total: lignes.length };
}

export async function creerSauvegarde(options: OptionsSauvegarde): Promise<Sauvegarde> {
  const quand = options.maintenant ?? new Date();
  const repertoire = join(options.destination, nomDePrise(quand));
  await mkdir(repertoire, { recursive: true });

  const cible = cibleDepuisUrl(options.databaseUrl);
  const cheminDump = join(repertoire, NOM_DUMP);
  await (options.dumper ?? pgDump)(cible, cheminDump);
  const dump = await empreinteDuFichier(cheminDump);

  const inventaire = await ecrireInventaire(options.prisma, join(repertoire, NOM_INVENTAIRE));
  const migrations = await etatDesMigrations(options.prisma);

  const locataires = await options.prisma.tenant.findMany({
    orderBy: { slug: 'asc' },
    select: { id: true, slug: true, name: true, active: true },
  });

  const manifeste: Manifeste = {
    schema: 1,
    produitLe: quand.toISOString(),
    version: options.version,
    base: {
      fichier: NOM_DUMP,
      format: 'pg_dump-custom',
      schemaPostgres: cible.schema,
      octets: dump.octets,
      sha256: dump.sha256,
      derniereMigration: migrations.derniere,
      migrationsAppliquees: migrations.total,
    },
    stockage: {
      fichier: NOM_INVENTAIRE,
      sha256: inventaire.sha256,
      racine: options.storageDir,
      pieces: inventaire.pieces,
      octetsClair: inventaire.octetsClair,
      scellees: inventaire.scellees,
      enClair: inventaire.enClair,
      purgees: inventaire.purgees,
      cles: inventaire.cles,
    },
    cleMaitre: {
      empreinte: options.cleMaitre ? empreinteCleMaitre(options.cleMaitre) : null,
      note: NOTE_CLE_MAITRE,
    },
    locataires: locataires.map((locataire) => ({
      id: locataire.id,
      slug: locataire.slug,
      nom: locataire.name,
      actif: locataire.active,
      pieces: inventaire.parLocataire.get(locataire.id) ?? 0,
    })),
  };

  const serialise = serialiserManifeste(manifeste);
  await writeFile(join(repertoire, NOM_MANIFESTE), serialise, 'utf8');

  return { repertoire, manifeste, empreinte: empreinteDe(serialise) };
}
