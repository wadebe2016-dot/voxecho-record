// En tête, avant tout ce qui charge la configuration : voir le module lui-même.
import { REFERENCE_CLE_TEST } from './helpers/chiffrement-actif';
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import JSZip from 'jszip';
import { EXPORT_FICHE_JSON, type ExportManifest } from '@voxecho/shared';
import { AppModule } from '../src/app.module';
import { IngestionService } from '../src/ingestion/ingestion.service';
import { hashPassword } from '../src/auth/password';
import { createTestPrisma, resetTestData } from './helpers/database';
import { audio, deposer, METADONNEES_TYPE } from './helpers/deposit';

const MOT_DE_PASSE = 'Demo!2026';

/**
 * Chiffrement au repos — CLAUDE.md §8 et §9.13.
 *
 * L'application est montée avec le chiffrement **actif**, ce qui n'est pas le
 * cas des autres suites : c'est le seul moyen de vérifier que la réécoute,
 * l'export et la purge fonctionnent à l'identique sur des pièces scellées. Si
 * l'un d'eux devait changer, le chiffrement ne serait pas transparent, et
 * c'est le §9.4 qui tomberait avec lui.
 */
describe('chiffrement au repos', () => {
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
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
    for (const [email, role] of [
      ['admin@a.cm', 'ADMIN'],
      ['auditeur@a.cm', 'AUDITOR'],
    ] as const) {
      await prisma.user.create({ data: { tenantId: banque, email, passwordHash, role } });
    }
  });

  /** Dépose un appel et l'ingère ; rend l'enregistrement et son clair. */
  async function ingerer(dureeSec = 3) {
    const clair = Buffer.from(audio(dureeSec));
    await deposer(ingestDir, {
      slug: 'banque-a',
      metadata: { ...METADONNEES_TYPE, durationSec: dureeSec },
      wav: clair,
    });
    await ingestion.scan();
    const recording = await prisma.recording.findFirstOrThrow({ where: { tenantId: banque } });
    return { recording, clair, chemin: join(storageDir, recording.filePath) };
  }

  async function jeton(email: string): Promise<string> {
    const reponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: MOT_DE_PASSE })
      .expect(200);
    return (reponse.body as { accessToken: string }).accessToken;
  }

  async function billet(token: string, id: string): Promise<string> {
    const reponse = await request(app.getHttpServer())
      .post(`/api/recordings/${id}/listen`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return (reponse.body as { ticket: string }).ticket;
  }

  describe('à l’ingestion', () => {
    it('scelle la pièce et l’inscrit comme telle', async () => {
      const { recording } = await ingerer();

      expect(recording.encrypted).toBe(true);
      expect(recording.keyRef).toBe(REFERENCE_CLE_TEST);

      const trace = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'INGEST' } });
      expect(trace.detail).toMatchObject({ chiffre: true, cle: REFERENCE_CLE_TEST });
    });

    it('ne laisse aucun wav lisible sur le disque', async () => {
      const { chemin } = await ingerer();
      const surDisque = await readFile(chemin);

      // Ni l'en-tête RIFF, ni le nom du format : le fichier n'est plus un wav.
      expect(surDisque.subarray(0, 4).toString('latin1')).not.toBe('RIFF');
      expect(surDisque.subarray(0, 8).toString('ascii')).toBe('VOXECHO1');
      expect(surDisque.includes(Buffer.from('WAVE'))).toBe(false);
    });

    it('garde en base l’empreinte et la taille du clair, pas du conteneur', async () => {
      const { recording, clair, chemin } = await ingerer();
      const surDisque = await readFile(chemin);

      // Le SHA-256 est celui de la preuve, pas de son emballage : c'est ce qui
      // permet à un contrôleur de le comparer à sa propre copie du wav.
      expect(recording.sha256).toBe(createHash('sha256').update(clair).digest('hex'));
      expect(Number(recording.sizeBytes)).toBe(clair.byteLength);
      expect(surDisque.byteLength).toBeGreaterThan(clair.byteLength);
    });
  });

  describe('à la réécoute', () => {
    it('sert un flux dont l’empreinte est celle de la base', async () => {
      const { recording, clair } = await ingerer();
      const token = await jeton('auditeur@a.cm');
      const ticket = await billet(token, recording.id);

      const flux = await request(app.getHttpServer())
        .get(`/api/recordings/${recording.id}/audio`)
        .query({ ticket })
        .responseType('blob')
        .expect(200);

      const corps = Buffer.from(flux.body as Buffer);
      expect(createHash('sha256').update(corps).digest('hex')).toBe(recording.sha256);
      expect(corps).toEqual(clair);
    });

    it('annonce la taille du clair, pas celle du conteneur', async () => {
      const { recording, clair } = await ingerer();
      const ticket = await billet(await jeton('auditeur@a.cm'), recording.id);

      const flux = await request(app.getHttpServer())
        .get(`/api/recordings/${recording.id}/audio`)
        .query({ ticket })
        .responseType('blob')
        .expect(200);

      expect(flux.headers['content-length']).toBe(String(clair.byteLength));
    });

    it.each([
      ['la sonde d’ouverture', 0, 1],
      ['un saut en milieu de piste', 20_000, 21_000],
      ['la fin du fichier', -1, -1],
    ])('sert %s comme sur une pièce en clair', async (_libelle, debut, fin) => {
      const { recording, clair } = await ingerer();
      const ticket = await billet(await jeton('auditeur@a.cm'), recording.id);

      const premier = debut === -1 ? clair.byteLength - 500 : debut;
      const dernier = fin === -1 ? clair.byteLength - 1 : fin;

      const flux = await request(app.getHttpServer())
        .get(`/api/recordings/${recording.id}/audio`)
        .query({ ticket })
        .set('Range', `bytes=${premier}-${dernier}`)
        .responseType('blob')
        .expect(206);

      expect(flux.headers['content-range']).toBe(`bytes ${premier}-${dernier}/${clair.byteLength}`);
      // La tranche servie est exactement celle du wav d'origine : c'est ce qui
      // fait que le §9.4 survit au chiffrement.
      expect(Buffer.from(flux.body as Buffer)).toEqual(clair.subarray(premier, dernier + 1));
    });

    it('rend 416 sur une plage hors du clair, avec la taille du clair', async () => {
      const { recording, clair } = await ingerer();
      const ticket = await billet(await jeton('auditeur@a.cm'), recording.id);

      const reponse = await request(app.getHttpServer())
        .get(`/api/recordings/${recording.id}/audio`)
        .query({ ticket })
        .set('Range', `bytes=${clair.byteLength + 10}-`)
        .expect(416);
      expect(reponse.headers['content-range']).toBe(`bytes */${clair.byteLength}`);
    });
  });

  it('exporte le wav en clair, d’empreinte concordante', async () => {
    const { recording, clair } = await ingerer();

    const reponse = await request(app.getHttpServer())
      .post(`/api/recordings/${recording.id}/export`)
      .set('Authorization', `Bearer ${await jeton('auditeur@a.cm')}`)
      .responseType('blob')
      .expect(200);

    expect(reponse.headers['x-export-integrite']).toBe('concordante');

    const zip = await JSZip.loadAsync(reponse.body as Buffer);
    const nomAudio = recording.filePath.split('/').pop() as string;
    const exporte = await zip.file(nomAudio)!.async('nodebuffer');
    expect(exporte).toEqual(clair);

    const manifest = JSON.parse(
      await zip.file(EXPORT_FICHE_JSON)!.async('string'),
    ) as ExportManifest;
    expect(manifest.preuve.sha256Export).toBe(recording.sha256);
  });

  it('signale une pièce dont le conteneur a été altéré, plutôt que de servir du bruit', async () => {
    const { recording, chemin } = await ingerer();
    const conteneur = await readFile(chemin);
    // Un octet retourné au milieu du chiffré : le sceau ne concorde plus.
    conteneur.writeUInt8(conteneur.readUInt8(200) ^ 0x01, 200);
    await writeFile(chemin, conteneur);

    const reponse = await request(app.getHttpServer())
      .post(`/api/recordings/${recording.id}/export`)
      .set('Authorization', `Bearer ${await jeton('auditeur@a.cm')}`)
      .expect(404);
    expect(JSON.stringify(reponse.body)).toMatch(/introuvable/);
  });

  it('lit encore les pièces rangées en clair avant l’activation', async () => {
    // Le chiffrement s'introduit progressivement : les anciennes pièces
    // restent lisibles tant qu'elles n'ont pas été scellées (§9.13).
    const { recording, clair, chemin } = await ingerer();
    await writeFile(chemin, clair);
    await prisma.recording.update({
      where: { id: recording.id },
      data: { encrypted: false, keyRef: null },
    });

    const ticket = await billet(await jeton('auditeur@a.cm'), recording.id);
    const flux = await request(app.getHttpServer())
      .get(`/api/recordings/${recording.id}/audio`)
      .query({ ticket })
      .responseType('blob')
      .expect(200);

    expect(Buffer.from(flux.body as Buffer)).toEqual(clair);
  });

  it('purge un conteneur comme n’importe quelle pièce', async () => {
    const { recording, chemin } = await ingerer();
    await prisma.retentionPolicy.create({
      data: { tenantId: banque, appliesTo: 'all', days: 1 },
    });
    await prisma.recording.update({
      where: { id: recording.id },
      data: { startedAt: new Date('2020-01-01T10:00:00Z') },
    });

    const admin = await jeton('admin@a.cm');
    const rapport = await request(app.getHttpServer())
      .post('/api/purge/reports')
      .set('Authorization', `Bearer ${admin}`)
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/purge/reports/${rapport.body.id}/execute`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ reason: 'Purge de conformité, rapport validé.' })
      .expect(200);

    await expect(readFile(chemin)).rejects.toThrow();
    expect((await prisma.recording.findFirstOrThrow({ where: { id: recording.id } })).status).toBe(
      'purged',
    );
  });
});
