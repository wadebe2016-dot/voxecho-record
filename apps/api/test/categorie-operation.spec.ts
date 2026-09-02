import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import JSZip from 'jszip';
import {
  buildWavPcm,
  EXPORT_FICHE_JSON,
  INGEST_OPERATION_CATEGORIES,
  INGEST_SAMPLE_RATE,
  type ExportManifest,
} from '@voxecho/shared';
import { IngestionService } from '../src/ingestion/ingestion.service';
import { hashPassword } from '../src/auth/password';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';
import { deposer } from './helpers/deposit';

const MOT_DE_PASSE = 'Demo!2026';

/**
 * Catégorie d'opération bancaire — contrat §3 et CLAUDE.md §9.10.
 *
 * Elle ne décrit pas l'appel — cela, c'est `direction` — mais ce qui s'y joue.
 * Une confirmation de chèque et un ordre de change ne relèvent pas des mêmes
 * obligations, et n'auront donc pas nécessairement la même conservation.
 */
describe('catégorie d’opération', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let ingestion: IngestionService;
  let passwordHash: string;
  let ingestDir: string;
  let storageDir: string;
  let banque: string;

  beforeAll(async () => {
    ingestDir = process.env.INGEST_DIR as string;
    storageDir = process.env.STORAGE_DIR as string;
    prisma = createTestPrisma();
    await prisma.$connect();
    passwordHash = await hashPassword(MOT_DE_PASSE);
    app = await createTestApp();
    ingestion = app.get(IngestionService);
  });

  afterAll(async () => {
    await resetTestData(prisma);
    await prisma.$disconnect();
    await app.close();
    await rm(ingestDir, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetTestData(prisma);
    await rm(ingestDir, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });

    banque = (await prisma.tenant.create({ data: { name: 'Banque A', slug: 'banque-a' } })).id;
    await prisma.user.create({
      data: { tenantId: banque, email: 'auditeur@a.cm', passwordHash, role: 'AUDITOR' },
    });
  });

  async function jeton(): Promise<string> {
    const reponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'auditeur@a.cm', password: MOT_DE_PASSE })
      .expect(200);
    return (reponse.body as { accessToken: string }).accessToken;
  }

  describe('à l’ingestion', () => {
    it('retient la catégorie déclarée par le producteur', async () => {
      await deposer(ingestDir, {
        slug: 'banque-a',
        metadata: { category: 'confirmation_cheque' },
      });
      await ingestion.scan();

      const recording = await prisma.recording.findFirstOrThrow({ where: { tenantId: banque } });
      expect(recording.operationCategory).toBe('confirmation_cheque');

      const trace = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'INGEST' } });
      expect(trace.detail).toMatchObject({ categorie: 'confirmation_cheque' });
    });

    it('range en « autre » le dépôt d’un producteur qui l’ignore', async () => {
      // Le champ est facultatif : un script post-enregistrement écrit avant
      // cette évolution reste conforme au schéma 1 (§9.10).
      await deposer(ingestDir, { slug: 'banque-a' });
      await ingestion.scan();

      const recording = await prisma.recording.findFirstOrThrow({ where: { tenantId: banque } });
      expect(recording.operationCategory).toBe('autre');
    });

    it('met en quarantaine une catégorie inconnue plutôt que de l’inventer', async () => {
      await deposer(ingestDir, {
        slug: 'banque-a',
        // Une valeur voisine mais inconnue : accent de trop, catégorie
        // inexistante. C'est une faute de frappe, pas une nouvelle catégorie.
        metadata: { category: 'confirmation_chèque' } as never,
      });
      await ingestion.scan();

      expect(await prisma.recording.count()).toBe(0);
      const trace = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'QUARANTINE' } });
      expect(JSON.stringify(trace.detail)).toMatch(/category/);
    });
  });

  describe('à la recherche', () => {
    beforeEach(async () => {
      let n = 0;
      for (const categorie of ['confirmation_cheque', 'operation_change', 'autre'] as const) {
        n += 1;
        await prisma.recording.create({
          data: {
            tenantId: banque,
            refci: `1000000${n}`,
            near: '1001',
            far: '699112233',
            direction: 'outbound',
            startedAt: new Date('2026-09-01T14:30:12+01:00'),
            durationSec: 60,
            filePath: `${banque}/2026/09/appel-${n}.wav`,
            sha256: `sha-${n}`.padEnd(64, '0'),
            sizeBytes: BigInt(1000),
            source: 'simulator',
            operationCategory: categorie,
          },
        });
      }
    });

    it('expose la catégorie de chaque appel', async () => {
      const reponse = await request(app.getHttpServer())
        .get('/api/recordings')
        .set('Authorization', `Bearer ${await jeton()}`)
        .expect(200);
      const categories = (reponse.body as { items: { operationCategory: string }[] }).items
        .map((item) => item.operationCategory)
        .sort();
      expect(categories).toEqual([...INGEST_OPERATION_CATEGORIES].sort());
    });

    it('filtre dessus, et consigne le critère au journal', async () => {
      const reponse = await request(app.getHttpServer())
        .get('/api/recordings?category=operation_change')
        .set('Authorization', `Bearer ${await jeton()}`)
        .expect(200);

      expect(reponse.body.total).toBe(1);
      expect(reponse.body.items[0].operationCategory).toBe('operation_change');

      const trace = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'SEARCH' },
        orderBy: { at: 'desc' },
      });
      expect(trace.detail).toMatchObject({ criteres: { categorie: 'operation_change' } });
    });

    it('refuse une catégorie inconnue au lieu de rendre une liste vide', async () => {
      await request(app.getHttpServer())
        .get('/api/recordings?category=virement')
        .set('Authorization', `Bearer ${await jeton()}`)
        .expect(400);
    });
  });

  it('figure dans la fiche d’export', async () => {
    const audio = buildWavPcm({ samples: new Int16Array(INGEST_SAMPLE_RATE) });
    const nomAudio = '20260901-143012_16778001_1001_699112233.wav';
    const filePath = `${banque}/2026/09/${nomAudio}`;
    const chemin = join(storageDir, filePath);
    await mkdir(dirname(chemin), { recursive: true });
    await writeFile(chemin, audio);

    const appel = await prisma.recording.create({
      data: {
        tenantId: banque,
        refci: '16778001',
        near: '1001',
        far: '699112233',
        direction: 'outbound',
        startedAt: new Date('2026-09-01T14:30:12+01:00'),
        durationSec: 60,
        filePath,
        sha256: createHash('sha256').update(audio).digest('hex'),
        sizeBytes: BigInt(audio.byteLength),
        source: 'simulator',
        operationCategory: 'operation_change',
      },
    });

    const reponse = await request(app.getHttpServer())
      .post(`/api/recordings/${appel.id}/export`)
      .set('Authorization', `Bearer ${await jeton()}`)
      .responseType('blob')
      .expect(200);

    const zip = await JSZip.loadAsync(reponse.body as Buffer);
    const manifest = JSON.parse(
      await zip.file(EXPORT_FICHE_JSON)!.async('string'),
    ) as ExportManifest;
    expect(manifest.appel.categorieOperation).toBe('operation_change');
  });
});
