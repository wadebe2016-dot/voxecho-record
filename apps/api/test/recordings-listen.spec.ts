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
 * Réécoute — CLAUDE.md §6. Deux exigences se tiennent ici : le flux doit se
 * comporter comme un lecteur audio l'attend (`Range`, `206`, `416`), et le
 * journal doit compter **une écoute par écoute**, pas une par requête HTTP.
 */
describe('réécoute d’un enregistrement', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let passwordHash: string;
  let storageDir: string;
  let banque: string;
  let microfinance: string;
  let appelId: string;
  let audio: Uint8Array;
  let empreinte: string;

  beforeAll(async () => {
    storageDir = process.env.STORAGE_DIR as string;
    prisma = createTestPrisma();
    await prisma.$connect();
    passwordHash = await hashPassword(MOT_DE_PASSE);
    app = await createTestApp();
    audio = buildWavPcm({ samples: new Int16Array(INGEST_SAMPLE_RATE * 3) });
    empreinte = createHash('sha256').update(audio).digest('hex');
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
    microfinance = (await prisma.tenant.create({ data: { name: 'MFI B', slug: 'mfi-b' } })).id;
    await prisma.user.create({
      data: { tenantId: banque, email: 'auditeur@a.cm', passwordHash, role: 'AUDITOR' },
    });
    await prisma.user.create({
      data: { tenantId: microfinance, email: 'admin@b.cm', passwordHash, role: 'ADMIN' },
    });

    appelId = (await creerEnregistrement(banque)).id;
  });

  async function creerEnregistrement(
    tenantId: string,
    options: { avecFichier?: boolean; refci?: string } = {},
  ) {
    const refci = options.refci ?? '16778001';
    const filePath = `${tenantId}/2026/09/20260901-143012_${refci}_1001_699112233.wav`;
    if (options.avecFichier !== false) {
      const destination = join(storageDir, filePath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, audio);
    }
    return prisma.recording.create({
      data: {
        tenantId,
        refci,
        near: '1001',
        far: '699112233',
        direction: 'outbound',
        startedAt: new Date('2026-09-01T13:30:12.000Z'),
        durationSec: 3,
        filePath,
        sha256: empreinte,
        sizeBytes: BigInt(audio.byteLength),
        source: 'simulator',
      },
      select: { id: true },
    });
  }

  async function jeton(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: MOT_DE_PASSE })
      .expect(200);
    return (response.body as { accessToken: string }).accessToken;
  }

  /** Ouvre une écoute et rend le billet — le geste de l'auditeur. */
  async function billetPour(id: string, email = 'auditeur@a.cm'): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`/api/recordings/${id}/listen`)
      .set('Authorization', `Bearer ${await jeton(email)}`)
      .expect(200);
    return (response.body as { ticket: string }).ticket;
  }

  const ecoutes = () => prisma.auditEvent.findMany({ where: { action: 'LISTEN' } });

  describe('ouverture de l’écoute', () => {
    it('rend un billet et inscrit l’écoute au journal, une seule fois', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/recordings/${appelId}/listen`)
        .set('Authorization', `Bearer ${await jeton('auditeur@a.cm')}`)
        .expect(200);

      expect(response.body).toEqual({ ticket: expect.any(String), expiresIn: expect.any(String) });
      expect(await ecoutes()).toHaveLength(1);
    });

    it('trace qui a écouté quoi, avec l’empreinte de ce qui a été entendu', async () => {
      await billetPour(appelId);

      const [evenement] = await ecoutes();
      const auditeur = await prisma.user.findUnique({ where: { email: 'auditeur@a.cm' } });
      expect(evenement).toMatchObject({
        tenantId: banque,
        userId: auditeur?.id,
        recordingId: appelId,
        detail: { refci: '16778001', sha256: empreinte, durationSec: 3 },
      });
    });

    it('refuse d’ouvrir l’écoute d’un appel d’un autre locataire', async () => {
      const autre = await creerEnregistrement(microfinance);

      await request(app.getHttpServer())
        .post(`/api/recordings/${autre.id}/listen`)
        .set('Authorization', `Bearer ${await jeton('auditeur@a.cm')}`)
        .expect(404);

      expect(await ecoutes()).toHaveLength(0);
    });

    it('refuse une écoute non authentifiée', async () => {
      await request(app.getHttpServer()).post(`/api/recordings/${appelId}/listen`).expect(401);
      expect(await ecoutes()).toHaveLength(0);
    });

    it('refuse d’ouvrir l’écoute d’un enregistrement purgé', async () => {
      await prisma.recording.update({ where: { id: appelId }, data: { status: 'purged' } });

      await request(app.getHttpServer())
        .post(`/api/recordings/${appelId}/listen`)
        .set('Authorization', `Bearer ${await jeton('auditeur@a.cm')}`)
        .expect(410);
    });
  });

  describe('flux audio', () => {
    it('sert le fichier entier, avec les en-têtes qu’un lecteur attend', async () => {
      const ticket = await billetPour(appelId);

      const response = await request(app.getHttpServer())
        .get(`/api/recordings/${appelId}/audio`)
        .query({ ticket })
        .responseType('blob')
        .expect(200);

      expect(response.headers['content-type']).toContain('audio/wav');
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(Number(response.headers['content-length'])).toBe(audio.byteLength);
    });

    it('sert des octets identiques à la preuve : le SHA-256 du flux est celui de la base', async () => {
      const ticket = await billetPour(appelId);

      const response = await request(app.getHttpServer())
        .get(`/api/recordings/${appelId}/audio`)
        .query({ ticket })
        .responseType('blob')
        .expect(200);

      const corps = Buffer.from(response.body as Buffer);
      expect(createHash('sha256').update(corps).digest('hex')).toBe(empreinte);
    });

    it('répond 206 et la tranche exacte à une demande de plage', async () => {
      const ticket = await billetPour(appelId);

      const response = await request(app.getHttpServer())
        .get(`/api/recordings/${appelId}/audio`)
        .query({ ticket })
        .set('Range', 'bytes=0-99')
        .responseType('blob')
        .expect(206);

      expect(response.headers['content-range']).toBe(`bytes 0-99/${audio.byteLength}`);
      expect(Number(response.headers['content-length'])).toBe(100);
      expect(Buffer.from(response.body as Buffer)).toEqual(Buffer.from(audio.slice(0, 100)));
    });

    it('sert la fin du fichier pour une plage ouverte', async () => {
      const ticket = await billetPour(appelId);
      const debut = audio.byteLength - 10;

      const response = await request(app.getHttpServer())
        .get(`/api/recordings/${appelId}/audio`)
        .query({ ticket })
        .set('Range', `bytes=${debut}-`)
        .responseType('blob')
        .expect(206);

      expect(response.headers['content-range']).toBe(
        `bytes ${debut}-${audio.byteLength - 1}/${audio.byteLength}`,
      );
      expect(Buffer.from(response.body as Buffer)).toEqual(Buffer.from(audio.slice(debut)));
    });

    it('répond 416 à une plage hors du fichier, en disant la taille réelle', async () => {
      const ticket = await billetPour(appelId);

      const response = await request(app.getHttpServer())
        .get(`/api/recordings/${appelId}/audio`)
        .query({ ticket })
        .set('Range', 'bytes=99999999-')
        .expect(416);

      expect(response.headers['content-range']).toBe(`bytes */${audio.byteLength}`);
    });

    it('n’ajoute aucune écoute au journal, quelles que soient les requêtes du lecteur', async () => {
      const ticket = await billetPour(appelId);

      // Ce qu'un navigateur fait vraiment : une sonde, puis des tranches.
      for (const plage of ['bytes=0-1', 'bytes=0-', 'bytes=100-199', 'bytes=200-']) {
        await request(app.getHttpServer())
          .get(`/api/recordings/${appelId}/audio`)
          .query({ ticket })
          .set('Range', plage)
          .responseType('blob')
          .expect(206);
      }

      expect(await ecoutes()).toHaveLength(1);
    });

    it('compte une écoute par ouverture : réécouter se voit au journal', async () => {
      await billetPour(appelId);
      await billetPour(appelId);

      expect(await ecoutes()).toHaveLength(2);
    });
  });

  describe('ce que le billet ne permet pas', () => {
    it('refuse le flux sans billet', async () => {
      await request(app.getHttpServer()).get(`/api/recordings/${appelId}/audio`).expect(400);
    });

    it('refuse un billet contrefait', async () => {
      await request(app.getHttpServer())
        .get(`/api/recordings/${appelId}/audio`)
        .query({ ticket: 'pas.un.billet' })
        .expect(401);
    });

    it('refuse un billet délivré pour un autre enregistrement', async () => {
      const autre = await creerEnregistrement(banque, { refci: '16778002' });
      const ticket = await billetPour(autre.id);

      await request(app.getHttpServer())
        .get(`/api/recordings/${appelId}/audio`)
        .query({ ticket })
        .expect(401);
    });

    it('ne vaut pas jeton d’accès : présenté en Bearer, il est refusé', async () => {
      const ticket = await billetPour(appelId);

      await request(app.getHttpServer())
        .get('/api/recordings')
        .set('Authorization', `Bearer ${ticket}`)
        .expect(401);
    });
  });

  describe('quand le stockage ne suit plus', () => {
    it('répond 404 si le fichier a disparu du stockage', async () => {
      const orphelin = await creerEnregistrement(banque, {
        avecFichier: false,
        refci: '16778003',
      });
      const ticket = await billetPour(orphelin.id);

      await request(app.getHttpServer())
        .get(`/api/recordings/${orphelin.id}/audio`)
        .query({ ticket })
        .expect(404);
    });

    it('répond 410 si l’enregistrement a été purgé entre-temps', async () => {
      const ticket = await billetPour(appelId);
      await prisma.recording.update({ where: { id: appelId }, data: { status: 'purged' } });

      await request(app.getHttpServer())
        .get(`/api/recordings/${appelId}/audio`)
        .query({ ticket })
        .expect(410);
    });
  });
});
