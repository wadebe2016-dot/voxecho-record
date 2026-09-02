import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { buildWavPcm, INGEST_SAMPLE_RATE } from '@voxecho/shared';
import { hashPassword } from '../src/auth/password';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026';

/**
 * Habilitation d'écoute — CLAUDE.md §9.9.
 *
 * Entendre la conversation d'un client n'est pas un droit d'exploitation. Le
 * SUPERVISOR consulte les appels et leurs métadonnées ; il ne les écoute pas,
 * et il ne les exporte pas — une archive contient l'audio, et ouvrir l'export
 * à qui n'a pas l'écoute rendrait la restriction décorative.
 */
describe('habilitation d’écoute', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let passwordHash: string;
  let storageDir: string;
  let banque: string;
  let appelId: string;

  beforeAll(async () => {
    storageDir = process.env.STORAGE_DIR as string;
    prisma = createTestPrisma();
    await prisma.$connect();
    passwordHash = await hashPassword(MOT_DE_PASSE);
    app = await createTestApp();
  });

  afterAll(async () => {
    await resetTestData(prisma);
    await prisma.$disconnect();
    await app.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetTestData(prisma);
    await rm(storageDir, { recursive: true, force: true });

    banque = (await prisma.tenant.create({ data: { name: 'Banque A', slug: 'banque-a' } })).id;
    for (const [email, role] of [
      ['admin@a.cm', 'ADMIN'],
      ['superviseur@a.cm', 'SUPERVISOR'],
      ['auditeur@a.cm', 'AUDITOR'],
    ] as const) {
      await prisma.user.create({ data: { tenantId: banque, email, passwordHash, role } });
    }

    const audio = buildWavPcm({ samples: new Int16Array(INGEST_SAMPLE_RATE) });
    const filePath = `${banque}/2026/09/appel.wav`;
    const chemin = join(storageDir, filePath);
    await mkdir(dirname(chemin), { recursive: true });
    await writeFile(chemin, audio);

    appelId = (
      await prisma.recording.create({
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
        },
      })
    ).id;
  });

  async function jeton(email: string): Promise<string> {
    const reponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: MOT_DE_PASSE })
      .expect(200);
    return (reponse.body as { accessToken: string }).accessToken;
  }

  it.each(['admin@a.cm', 'auditeur@a.cm'])('%s peut ouvrir une écoute', async (email) => {
    await request(app.getHttpServer())
      .post(`/api/recordings/${appelId}/listen`)
      .set('Authorization', `Bearer ${await jeton(email)}`)
      .expect(200);
  });

  it('le SUPERVISOR ne peut pas ouvrir d’écoute', async () => {
    await request(app.getHttpServer())
      .post(`/api/recordings/${appelId}/listen`)
      .set('Authorization', `Bearer ${await jeton('superviseur@a.cm')}`)
      .expect(403);
    expect(await prisma.auditEvent.count({ where: { action: 'LISTEN' } })).toBe(0);
  });

  it('le SUPERVISOR ne peut pas exporter : l’archive contient l’audio', async () => {
    await request(app.getHttpServer())
      .post(`/api/recordings/${appelId}/export`)
      .set('Authorization', `Bearer ${await jeton('superviseur@a.cm')}`)
      .expect(403);
    expect(await prisma.auditEvent.count({ where: { action: 'EXPORT' } })).toBe(0);
  });

  it('le SUPERVISOR garde la consultation : il voit l’appel et ses métadonnées', async () => {
    const reponse = await request(app.getHttpServer())
      .get('/api/recordings')
      .set('Authorization', `Bearer ${await jeton('superviseur@a.cm')}`)
      .expect(200);

    expect(reponse.body.total).toBe(1);
    // Y compris l'empreinte : constater l'intégrité ne suppose pas d'entendre.
    expect(reponse.body.items[0].sha256).toHaveLength(64);
  });

  it('n’ayant pas de billet, le SUPERVISOR n’atteint pas le flux non plus', async () => {
    // La route audio est ouverte au sens du garde JWT : c'est le billet qui
    // l'autorise, et le billet ne s'obtient qu'en ouvrant une écoute.
    await request(app.getHttpServer())
      .get(`/api/recordings/${appelId}/audio?ticket=nimportequoi`)
      .expect(401);
  });
});
