import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { creerSauvegarde, type Sauvegarde } from '../src/backup/sauvegarde.service';
import { verifierBaseRestauree, cibleLisible } from '../src/backup/base-restauree';
import { NOM_INVENTAIRE } from '../src/backup/manifeste';
import { cibleDepuisUrl, pgDump } from '../src/backup/pg-dump';
import { createTestPrisma, resetTestData, testDatabaseUrl, testSchema } from './helpers/database';

/**
 * Constat d'après-restauration — CLAUDE.md §9.15.
 *
 * Deux façons de l'éprouver, et les deux comptent. La plupart des cas
 * fabriquent l'écart directement en base : c'est ce qu'aurait produit une
 * restauration incomplète, et cela se joue partout. Un cas, lui, restaure
 * **pour de vrai** — `pg_dump` puis `pg_restore` dans une base à part — parce
 * qu'un constat d'après-restauration qui n'aurait jamais vu de restauration
 * ne prouverait rien du geste qu'il accompagne.
 */

const outilsPresents = (() => {
  try {
    execFileSync('pg_dump', ['--version'], { stdio: 'pipe' });
    execFileSync('pg_restore', ['--version'], { stdio: 'pipe' });
    execFileSync('psql', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe('constat d’après-restauration', () => {
  let prisma: PrismaClient;
  let racine: string;
  let storageDir: string;
  let backupDir: string;
  let tenantId: string;

  async function ranger(nom: string, options: { purgee?: boolean } = {}): Promise<string> {
    const clair = randomBytes(1_600);
    const enregistrement = await prisma.recording.create({
      data: {
        tenantId,
        refci: nom,
        near: '1001',
        far: '699112233',
        direction: 'outbound',
        startedAt: new Date('2026-09-01T13:30:12Z'),
        durationSec: 1,
        filePath: join(tenantId, '2026', '09', `${nom}.wav`),
        sha256: createHash('sha256').update(clair).digest('hex'),
        sizeBytes: BigInt(clair.length),
        source: 'simulator',
        status: options.purgee ? 'purged' : 'stored',
        encrypted: true,
        keyRef: 'k-test',
      },
      select: { id: true },
    });
    return enregistrement.id;
  }

  /**
   * Prise dont seul l'inventaire compte : le constat porte sur la base, pas
   * sur le dump. Les cas qui ont besoin d'un vrai dump le demandent à part.
   */
  async function prendre(): Promise<Sauvegarde> {
    return creerSauvegarde({
      prisma,
      destination: backupDir,
      storageDir,
      databaseUrl: testDatabaseUrl(),
      cleMaitre: randomBytes(32),
      version: '0.1.0-test',
      dumper: async (_cible, destination) => writeFile(destination, 'PGDMP-faux'),
    });
  }

  /** Le constat, mené contre la base que Prisma a sous la main. */
  async function constater(prise: Sauvegarde, cible: PrismaClient = prisma) {
    return verifierBaseRestauree({
      prisma: cible,
      manifeste: prise.manifeste,
      cheminInventaire: join(prise.repertoire, NOM_INVENTAIRE),
      cible: testDatabaseUrl(),
    });
  }

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    racine = join(process.env.STORAGE_DIR as string, '..', 'restauration');
    storageDir = join(racine, 'storage');
    backupDir = join(racine, 'backups');
  });

  afterAll(async () => {
    await resetTestData(prisma);
    await prisma.$disconnect();
    await rm(racine, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetTestData(prisma);
    await rm(racine, { recursive: true, force: true });
    await mkdir(backupDir, { recursive: true });
    const locataire = await prisma.tenant.create({
      data: { name: 'Banque de démonstration', slug: 'demo' },
      select: { id: true },
    });
    tenantId = locataire.id;
  });

  it('tient pour fidèle une base qui rend exactement la prise', async () => {
    await ranger('un');
    await ranger('deux');
    await ranger('detruite', { purgee: true });

    const rapport = await constater(await prendre());

    expect(rapport.anomalies).toEqual([]);
    expect(rapport.fidele).toBe(true);
    expect(rapport.migration.etat).toBe('conforme');
    // Les pièces purgées font partie du compte : leur ligne doit revenir,
    // c'est elle qui prouve ce qui a été détruit (§9.7).
    expect(rapport.pieces).toMatchObject({ attendues: 3, retrouvees: 3, enTrop: 0 });
    expect(rapport.locataires).toMatchObject({ attendus: 1, trouves: 1 });
  });

  it('constate un enregistrement que la restauration n’a pas rendu', async () => {
    const id = await ranger('perdue');
    await ranger('rendue');
    const prise = await prendre();

    await prisma.recording.delete({ where: { id } });

    const rapport = await constater(prise);
    expect(rapport.pieces.absentes.total).toBe(1);
    expect(rapport.pieces.absentes.exemples[0]).toMatch(/perdue\.wav$/);
    expect(rapport.pieces.retrouvees).toBe(1);
    expect(rapport.fidele).toBe(false);
  });

  it('constate une ligne revenue autrement qu’elle n’était partie', async () => {
    const id = await ranger('changee');
    const prise = await prendre();

    // Une empreinte qui a changé en base, c'est la preuve qui ne désigne plus
    // le même fichier : le constat doit nommer le champ, pas seulement crier.
    await prisma.recording.update({
      where: { id },
      data: { sha256: 'a'.repeat(64), status: 'archived' },
    });

    const rapport = await constater(prise);
    expect(rapport.pieces.divergentes.total).toBe(1);
    expect(rapport.pieces.divergentes.exemples[0]).toMatch(/empreinte a{8}/);
    expect(rapport.pieces.divergentes.exemples[0]).toMatch(/statut archived au lieu de stored/);
    expect(rapport.fidele).toBe(false);
  });

  it('constate des enregistrements que l’inventaire ne décrit pas', async () => {
    await ranger('connue');
    const prise = await prendre();
    await ranger('apparue-apres');

    const rapport = await constater(prise);
    expect(rapport.pieces.enTrop).toBe(1);
    expect(rapport.anomalies.join(' ')).toMatch(/qu’aucune ligne de l’inventaire ne décrit/);
  });

  it('constate un locataire manquant et un compte de pièces qui ne suit pas', async () => {
    await ranger('une');
    const prise = await prendre();
    await prisma.recording.deleteMany();
    await prisma.tenant.deleteMany();

    const rapport = await constater(prise);
    expect(rapport.locataires.divergents.exemples.join(' ')).toMatch(
      /demo : absent de la base restaurée/,
    );
    expect(rapport.fidele).toBe(false);
  });

  it('distingue une base en retard d’une base seulement plus avancée', async () => {
    await ranger('une');
    const prise = await prendre();

    // Une base qui a reçu les migrations parues depuis la prise est une
    // manœuvre saine : elle ne doit pas être annoncée comme un sinistre.
    const plusAvancee = await verifierBaseRestauree({
      prisma,
      manifeste: {
        ...prise.manifeste,
        base: {
          ...prise.manifeste.base,
          migrationsAppliquees: prise.manifeste.base.migrationsAppliquees - 1,
        },
      },
      cheminInventaire: join(prise.repertoire, NOM_INVENTAIRE),
      cible: testDatabaseUrl(),
    });
    expect(plusAvancee.migration.etat).toBe('base plus avancée');
    expect(plusAvancee.fidele).toBe(true);

    // Une base en retard, elle, ne peut pas porter ce qu'on y a restauré.
    const enRetard = await verifierBaseRestauree({
      prisma,
      manifeste: {
        ...prise.manifeste,
        base: {
          ...prise.manifeste.base,
          migrationsAppliquees: prise.manifeste.base.migrationsAppliquees + 1,
          derniereMigration: '99999999999999_a_venir',
        },
      },
      cheminInventaire: join(prise.repertoire, NOM_INVENTAIRE),
      cible: testDatabaseUrl(),
    });
    expect(enRetard.migration.etat).toBe('base en retard');
    expect(enRetard.fidele).toBe(false);
  });

  it('n’affiche jamais le mot de passe de la base constatée', () => {
    expect(
      cibleLisible('postgresql://voxecho:s3cr3t@localhost:5432/voxecho?schema=public'),
    ).not.toMatch(/s3cr3t/);
    expect(cibleLisible('pas une url')).toBe('base désignée par DATABASE_URL');
  });

  (outilsPresents ? describe : describe.skip)('restauration réelle', () => {
    const schema = testSchema();
    const baseRestauree = `voxecho_restauration_${schema}`;

    /** URL de la base de secours, dans le même serveur que la base de test. */
    function urlRestauree(): string {
      const url = new URL(testDatabaseUrl());
      url.pathname = `/${baseRestauree}`;
      return url.toString();
    }

    function psql(base: string, commande: string): void {
      const url = new URL(testDatabaseUrl());
      url.pathname = `/${base}`;
      url.searchParams.delete('schema');
      execFileSync('psql', [url.toString(), '-v', 'ON_ERROR_STOP=1', '-c', commande], {
        stdio: 'pipe',
      });
    }

    afterAll(() => {
      try {
        psql('postgres', `DROP DATABASE IF EXISTS ${baseRestauree}`);
      } catch {
        // La base de secours est un accessoire de test : son ménage ne doit
        // pas faire échouer une suite par ailleurs verte.
      }
    });

    it('rend, après pg_restore, exactement ce que la prise annonçait', async () => {
      await ranger('un');
      await ranger('deux');
      await ranger('detruite', { purgee: true });

      const prise = await creerSauvegarde({
        prisma,
        destination: backupDir,
        storageDir,
        databaseUrl: testDatabaseUrl(),
        cleMaitre: randomBytes(32),
        version: '0.1.0-test',
        dumper: pgDump,
      });

      psql('postgres', `DROP DATABASE IF EXISTS ${baseRestauree}`);
      psql('postgres', `CREATE DATABASE ${baseRestauree}`);
      execFileSync(
        'pg_restore',
        [
          '--dbname',
          cibleDepuisUrl(urlRestauree()).url,
          '--no-owner',
          '--no-privileges',
          join(prise.repertoire, prise.manifeste.base.fichier),
        ],
        { stdio: 'pipe' },
      );

      const secours = new PrismaClient({ datasources: { db: { url: urlRestauree() } } });
      try {
        const rapport = await constater(prise, secours);
        expect(rapport.anomalies).toEqual([]);
        expect(rapport.fidele).toBe(true);
        expect(rapport.pieces).toMatchObject({ attendues: 3, retrouvees: 3, enTrop: 0 });

        // Et si la base de secours perd une ligne, le constat le dit : la
        // vérification porte bien sur elle, pas sur la base d'origine.
        await secours.recording.deleteMany({ where: { refci: 'un' } });
        const apres = await constater(prise, secours);
        expect(apres.pieces.absentes.total).toBe(1);
        expect(apres.fidele).toBe(false);
      } finally {
        await secours.$disconnect();
      }
    }, 120_000);
  });
});
