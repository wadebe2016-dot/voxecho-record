import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { IngestionService } from '../src/ingestion/ingestion.service';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';
import { audio, deposer, RADICAL_TYPE } from './helpers/deposit';

/**
 * Ingestion — contrat CLAUDE.md §3. Les répertoires sont de vrais répertoires
 * temporaires : ce qui est vérifié ici, c'est le comportement sur un système
 * de fichiers, pas une abstraction qui le simulerait.
 */
describe('ingestion', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let ingestion: IngestionService;
  let racine: string;
  let ingestDir: string;
  let storageDir: string;
  let quarantineDir: string;
  let banque: string;
  let microfinance: string;

  beforeAll(async () => {
    // Les répertoires sont fixés par `test/setup/env.ts`, avant l'import des
    // modules applicatifs : la configuration Nest est lue au chargement.
    ingestDir = process.env.INGEST_DIR as string;
    storageDir = process.env.STORAGE_DIR as string;
    quarantineDir = process.env.QUARANTINE_DIR as string;
    racine = dirname(ingestDir);

    prisma = createTestPrisma();
    await prisma.$connect();
    app = await createTestApp();
    ingestion = app.get(IngestionService);
  });

  afterAll(async () => {
    await resetTestData(prisma);
    await prisma.$disconnect();
    await app.close();
    await rm(racine, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetTestData(prisma);
    await rm(ingestDir, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
    await rm(quarantineDir, { recursive: true, force: true });

    banque = (await prisma.tenant.create({ data: { name: 'Banque A', slug: 'banque-a' } })).id;
    microfinance = (await prisma.tenant.create({ data: { name: 'MFI B', slug: 'mfi-b' } })).id;
  });

  const evenements = (action: 'INGEST' | 'QUARANTINE') =>
    prisma.auditEvent.findMany({ where: { action }, orderBy: { at: 'asc' } });

  it('ingère une paire complète, la range et l’empreint', async () => {
    const depot = await deposer(ingestDir, { slug: 'banque-a' });
    const attendu = createHash('sha256')
      .update(await readFile(depot.cheminWav))
      .digest('hex');

    const report = await ingestion.scan();

    expect(report).toMatchObject({ ingested: 1, quarantined: 0, duplicates: 0 });

    const recording = await prisma.recording.findFirstOrThrow();
    expect(recording.tenantId).toBe(banque);
    expect(recording.refci).toBe('16778001');
    expect(recording.near).toBe('1001');
    expect(recording.far).toBe('699112233');
    expect(recording.direction).toBe('outbound');
    expect(recording.durationSec).toBe(3);
    expect(recording.status).toBe('stored');
    expect(recording.source).toBe('simulator');
    expect(recording.sha256).toBe(attendu);
    expect(Number(recording.sizeBytes)).toBeGreaterThan(0);

    // Rangé sous STORAGE_DIR/<tenantId>/<yyyy>/<mm>/, nom conservé.
    expect(recording.filePath).toBe(`${banque}/2026/09/${RADICAL_TYPE}.wav`);
    expect(existsSync(join(storageDir, recording.filePath))).toBe(true);
    // La déclaration d'origine du producteur reste à côté de la preuve.
    expect(existsSync(join(storageDir, `${banque}/2026/09/${RADICAL_TYPE}.json`))).toBe(true);
    // Plus rien dans le répertoire d'ingestion.
    expect(existsSync(depot.cheminWav)).toBe(false);
    expect(existsSync(depot.cheminJson)).toBe(false);
  });

  it('trace l’ingestion au journal d’audit, rattachée à l’enregistrement', async () => {
    await deposer(ingestDir, { slug: 'banque-a' });
    await ingestion.scan();

    const recording = await prisma.recording.findFirstOrThrow();
    const [evenement] = await evenements('INGEST');
    expect(evenement?.tenantId).toBe(banque);
    expect(evenement?.recordingId).toBe(recording.id);
    expect(evenement?.userId).toBeNull();
    expect(evenement?.detail).toMatchObject({ radical: RADICAL_TYPE, sha256: recording.sha256 });
  });

  it('attribue le dépôt au locataire de son sous-répertoire, et à lui seul', async () => {
    await deposer(ingestDir, { slug: 'banque-a' });
    await deposer(ingestDir, {
      slug: 'mfi-b',
      radical: '20260901-150000_16778009_2001_677889900',
      metadata: { refci: '16778009', near: '2001', far: '677889900' },
    });

    await ingestion.scan();

    const chezBanque = await prisma.recording.findMany({ where: { tenantId: banque } });
    const chezMfi = await prisma.recording.findMany({ where: { tenantId: microfinance } });
    expect(chezBanque).toHaveLength(1);
    expect(chezMfi).toHaveLength(1);
    expect(chezBanque[0]?.refci).toBe('16778001');
    expect(chezMfi[0]?.refci).toBe('16778009');
  });

  it('met en quarantaine un json malformé, sans rien créer', async () => {
    await deposer(ingestDir, { slug: 'banque-a', metadata: '{ ceci n’est pas du json' });

    const report = await ingestion.scan();

    expect(report.ingested).toBe(0);
    expect(await prisma.recording.count()).toBe(0);
    expect(existsSync(join(quarantineDir, 'banque-a', `${RADICAL_TYPE}.wav`))).toBe(true);
    expect(existsSync(join(quarantineDir, 'banque-a', `${RADICAL_TYPE}.json`))).toBe(true);

    const [evenement] = await evenements('QUARANTINE');
    expect(evenement?.tenantId).toBe(banque);
    expect(JSON.stringify(evenement?.detail)).toContain('json illisible');
  });

  it('met en quarantaine des métadonnées hors contrat', async () => {
    await deposer(ingestDir, { slug: 'banque-a', metadata: { direction: 'sortant' as never } });

    await ingestion.scan();

    expect(await prisma.recording.count()).toBe(0);
    const [evenement] = await evenements('QUARANTINE');
    expect(JSON.stringify(evenement?.detail)).toContain('direction');
  });

  it('met en quarantaine un wav tronqué : l’audio ne tient pas ce que l’en-tête promet', async () => {
    const complet = audio(180);
    await deposer(ingestDir, {
      slug: 'banque-a',
      metadata: { durationSec: 180 },
      wav: complet.slice(0, Math.floor(complet.byteLength / 3)),
    });

    await ingestion.scan();

    expect(await prisma.recording.count()).toBe(0);
    const [evenement] = await evenements('QUARANTINE');
    expect(JSON.stringify(evenement?.detail)).toContain('tronqué');
  });

  it('met en quarantaine un audio dont la durée dément le json', async () => {
    await deposer(ingestDir, {
      slug: 'banque-a',
      metadata: { durationSec: 183 },
      wav: audio(4), // le json annonce trois minutes, le fichier en porte quatre secondes
    });

    await ingestion.scan();

    expect(await prisma.recording.count()).toBe(0);
    const [evenement] = await evenements('QUARANTINE');
    expect(JSON.stringify(evenement?.detail)).toContain('durée incohérente');
  });

  it('met en quarantaine un nom qui contredit les métadonnées', async () => {
    await deposer(ingestDir, {
      slug: 'banque-a',
      radical: '20260901-143012_16778001_1001_699112233',
      metadata: { far: '677000000' },
    });

    await ingestion.scan();

    expect(await prisma.recording.count()).toBe(0);
    const [evenement] = await evenements('QUARANTINE');
    expect(JSON.stringify(evenement?.detail)).toContain('désaccord');
  });

  it('met en quarantaine un json orphelin : le wav ne viendra plus', async () => {
    await deposer(ingestDir, { slug: 'banque-a', sans: 'wav' });

    const report = await ingestion.scan();

    expect(report.quarantined).toBe(1);
    expect(existsSync(join(quarantineDir, 'banque-a', `${RADICAL_TYPE}.json`))).toBe(true);
    const [evenement] = await evenements('QUARANTINE');
    expect(JSON.stringify(evenement?.detail)).toContain('wav manquant');
  });

  it('laisse en place un wav dont le json n’est pas encore arrivé', async () => {
    const depot = await deposer(ingestDir, { slug: 'banque-a', sans: 'json' });

    const report = await ingestion.scan();

    // Le json arrive en dernier : un wav seul est un dépôt en cours, pas une
    // anomalie. Le toucher ferait perdre l'appel.
    expect(report).toMatchObject({ ingested: 0, quarantined: 0, pending: 1 });
    expect(existsSync(depot.cheminWav)).toBe(true);

    // Le json arrive, le balayage suivant ingère.
    await deposer(ingestDir, { slug: 'banque-a', sans: 'wav' });
    expect(await ingestion.scan()).toMatchObject({ ingested: 1 });
  });

  it('est idempotent : re-déposer le même fichier ne crée pas de doublon', async () => {
    await deposer(ingestDir, { slug: 'banque-a' });
    await ingestion.scan();
    const premier = await prisma.recording.findFirstOrThrow();

    await deposer(ingestDir, { slug: 'banque-a' });
    const report = await ingestion.scan();

    expect(report).toMatchObject({ ingested: 0, duplicates: 1, quarantined: 0 });
    expect(await prisma.recording.count()).toBe(1);
    expect((await prisma.recording.findFirstOrThrow()).id).toBe(premier.id);

    // No-op, mais tracé : le journal doit pouvoir en rendre compte.
    const traces = await evenements('INGEST');
    expect(traces).toHaveLength(2);
    expect(traces[1]?.detail).toMatchObject({ idempotent: true });
  });

  it('met en quarantaine un re-dépôt de même nom mais d’empreinte différente', async () => {
    await deposer(ingestDir, { slug: 'banque-a' });
    await ingestion.scan();
    const origine = await prisma.recording.findFirstOrThrow();

    // Même appel, autre contenu : c'est un conflit, pas un doublon.
    await deposer(ingestDir, { slug: 'banque-a', wav: audio(4), metadata: { durationSec: 4 } });
    const report = await ingestion.scan();

    expect(report.quarantined).toBe(2);
    expect(await prisma.recording.count()).toBe(1);
    const inchange = await prisma.recording.findFirstOrThrow();
    expect(inchange.sha256).toBe(origine.sha256);
    expect(existsSync(join(storageDir, origine.filePath))).toBe(true);

    const dernier = (await evenements('QUARANTINE')).at(-1);
    expect(JSON.stringify(dernier?.detail)).toContain("conflit d'empreinte");
  });

  it('ne crée jamais de locataire depuis un répertoire inconnu', async () => {
    await deposer(ingestDir, { slug: 'banque-fantome' });

    const report = await ingestion.scan();

    expect(report.ingested).toBe(0);
    expect(await prisma.tenant.count()).toBe(2);
    expect(await prisma.recording.count()).toBe(0);
    expect(existsSync(join(quarantineDir, '_inconnu', 'banque-fantome'))).toBe(true);

    const [evenement] = await evenements('QUARANTINE');
    expect(evenement?.tenantId).toBeNull(); // personne à qui l'attribuer
    expect(JSON.stringify(evenement?.detail)).toContain('aucun locataire actif');
  });

  it('met en quarantaine les dépôts d’un locataire désactivé', async () => {
    await prisma.tenant.update({ where: { id: microfinance }, data: { active: false } });
    await deposer(ingestDir, { slug: 'mfi-b' });

    await ingestion.scan();

    expect(await prisma.recording.count()).toBe(0);
    expect(existsSync(join(quarantineDir, '_inconnu', 'mfi-b'))).toBe(true);
    const [evenement] = await evenements('QUARANTINE');
    expect(evenement?.tenantId).toBeNull();
  });

  it('met en quarantaine un fichier déposé à la racine, faute de locataire désigné', async () => {
    await deposer(ingestDir, { slug: 'banque-a' }); // crée INGEST_DIR
    await writeFile(join(ingestDir, `${RADICAL_TYPE}.wav`), audio(3));

    await ingestion.scan();

    expect(existsSync(join(quarantineDir, '_inconnu', `${RADICAL_TYPE}.wav`))).toBe(true);
    const racines = (await evenements('QUARANTINE')).filter((e) => e.tenantId === null);
    expect(racines).toHaveLength(1);
    expect(JSON.stringify(racines[0]?.detail)).toContain("racine d'INGEST_DIR");
  });

  it('met en quarantaine un fichier d’extension étrangère au contrat', async () => {
    const depot = await deposer(ingestDir, { slug: 'banque-a' });
    await writeFile(join(depot.dir, 'notes.txt'), 'consigne interne');

    const report = await ingestion.scan();

    expect(report.ingested).toBe(1); // la paire valide passe quand même
    expect(existsSync(join(quarantineDir, 'banque-a', 'notes.txt'))).toBe(true);
  });

  it('ingère un lot sans en perdre un seul', async () => {
    for (let index = 0; index < 20; index += 1) {
      const numero = String(16778000 + index);
      await deposer(ingestDir, {
        slug: 'banque-a',
        radical: `20260901-1430${String(index).padStart(2, '0')}_${numero}_1001_699112233`,
        metadata: { refci: numero },
      });
    }

    const report = await ingestion.scan();

    expect(report.ingested).toBe(20);
    expect(await prisma.recording.count()).toBe(20);
    expect(await prisma.auditEvent.count({ where: { action: 'INGEST' } })).toBe(20);
  });
});
