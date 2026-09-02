import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { IngestionService } from '../src/ingestion/ingestion.service';
import { hashPassword } from '../src/auth/password';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026';
const SIMULATEUR = join(__dirname, '..', '..', '..', 'tools', 'simulator');
const LOT = 12;

/**
 * Sortie du jalon S3 — CLAUDE.md §7 : « démo bout-en-bout sur données
 * simulées ».
 *
 * Le scénario est celui d'un contrôle : la téléphonie dépose des appels, le
 * portail les ingère, un auditeur les cherche, en écoute un, et le journal
 * rend compte de tout ce qu'il a fait. Rien n'est simulé ici sauf la
 * téléphonie elle-même — c'est le vrai simulateur qui est lancé, en ligne de
 * commande, exactement comme un opérateur le ferait.
 *
 * Ce test est la démonstration : il se rejoue à chaque CI plutôt que de
 * dépendre de quelqu'un qui se souvient des commandes.
 */
describe('démo bout-en-bout sur données simulées', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let ingestion: IngestionService;
  let banque: string;
  const ingestDir = process.env.INGEST_DIR as string;
  const storageDir = process.env.STORAGE_DIR as string;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    app = await createTestApp();
    ingestion = app.get(IngestionService);

    await resetTestData(prisma);
    await rm(ingestDir, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });

    banque = (await prisma.tenant.create({ data: { name: 'Banque A', slug: 'banque-a' } })).id;
    await prisma.user.create({
      data: {
        tenantId: banque,
        email: 'auditeur@a.cm',
        passwordHash: await hashPassword(MOT_DE_PASSE),
        role: 'AUDITOR',
      },
    });

    // 1. La téléphonie dépose. Graine fixée : la démonstration se rejoue à
    //    l'identique, ce qu'un contrôleur peut demander.
    execFileSync(
      'pnpm',
      [
        'exec',
        'tsx',
        'src/index.ts',
        '--batch',
        String(LOT),
        '--tenant',
        'banque-a',
        '--dir',
        ingestDir,
        '--seed',
        '20260901',
      ],
      { cwd: SIMULATEUR, stdio: 'pipe' },
    );

    // 2. Le portail ingère.
    await ingestion.scan();
  }, 300_000);

  afterAll(async () => {
    await resetTestData(prisma);
    await prisma.$disconnect();
    await app.close();
    await rm(ingestDir, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
  });

  async function jetonAuditeur(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'auditeur@a.cm', password: MOT_DE_PASSE })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  it('les appels déposés sont ingérés, empreints et rangés', async () => {
    const enregistrements = await prisma.recording.findMany({ where: { tenantId: banque } });

    expect(enregistrements).toHaveLength(LOT);
    expect(new Set(enregistrements.map((e) => e.sha256)).size).toBe(LOT);
    expect(enregistrements.every((e) => e.status === 'stored')).toBe(true);
    expect(await prisma.auditEvent.count({ where: { action: 'INGEST' } })).toBe(LOT);
  });

  it('l’auditeur retrouve un appel par son correspondant, et sa recherche est tracée', async () => {
    const cible = await prisma.recording.findFirstOrThrow({ where: { tenantId: banque } });

    const response = await request(app.getHttpServer())
      .get('/api/recordings')
      .set('Authorization', `Bearer ${await jetonAuditeur()}`)
      .query({ phone: cible.far })
      .expect(200);

    const items = (response.body as { items: { id: string }[] }).items;
    expect(items.some((item) => item.id === cible.id)).toBe(true);

    const recherche = await prisma.auditEvent.findFirst({
      where: { action: 'SEARCH' },
      orderBy: { at: 'desc' },
    });
    expect(recherche?.detail).toMatchObject({ criteres: { numero: cible.far } });
  });

  it('il écoute l’appel : le flux servi est la preuve rangée, et l’écoute est au journal', async () => {
    const cible = await prisma.recording.findFirstOrThrow({ where: { tenantId: banque } });
    const jeton = await jetonAuditeur();

    const ouverture = await request(app.getHttpServer())
      .post(`/api/recordings/${cible.id}/listen`)
      .set('Authorization', `Bearer ${jeton}`)
      .expect(200);
    const { ticket } = ouverture.body as { ticket: string };

    // Le lecteur sonde d'abord, comme le fait un navigateur…
    const sonde = await request(app.getHttpServer())
      .get(`/api/recordings/${cible.id}/audio`)
      .query({ ticket })
      .set('Range', 'bytes=0-1')
      .responseType('blob')
      .expect(206);
    expect(sonde.headers['content-range']).toBe(`bytes 0-1/${cible.sizeBytes}`);

    // … puis réclame le fichier, dont l'empreinte doit être celle de la base.
    const flux = await request(app.getHttpServer())
      .get(`/api/recordings/${cible.id}/audio`)
      .query({ ticket })
      .responseType('blob')
      .expect(200);
    const corps = Buffer.from(flux.body as Buffer);
    expect(createHash('sha256').update(corps).digest('hex')).toBe(cible.sha256);

    const ecoutes = await prisma.auditEvent.findMany({
      where: { action: 'LISTEN', recordingId: cible.id },
    });
    expect(ecoutes).toHaveLength(1);
  });

  it('le journal raconte le contrôle, et rien de ce locataire ne lui échappe', async () => {
    const actions = await prisma.auditEvent.groupBy({
      by: ['action'],
      where: { tenantId: banque },
      _count: { action: true },
    });
    const parAction = Object.fromEntries(actions.map((a) => [a.action, a._count.action]));

    expect(parAction.INGEST).toBe(LOT);
    expect(parAction.LOGIN).toBeGreaterThanOrEqual(1);
    expect(parAction.SEARCH).toBeGreaterThanOrEqual(1);
    expect(parAction.LISTEN).toBe(1);

    // Le journal est append-only : ce qui vient d'être écrit ne s'efface pas.
    await expect(prisma.auditEvent.deleteMany({ where: { tenantId: banque } })).rejects.toThrow(
      /append-only/,
    );
  });
});
