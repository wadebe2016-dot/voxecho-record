import { createHash } from 'node:crypto';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { buildWavPcm, INGEST_SAMPLE_RATE } from '@voxecho/shared';
import { hashPassword } from '../src/auth/password';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026';
const MOTIF_PURGE = 'Purge trimestrielle, rapport validé par la conformité.';
const MOTIF_HOLD = 'Contentieux 2026-114 : pièce réclamée par le contrôle.';

/**
 * Purge — CLAUDE.md §5 et §9.7.
 *
 * Le seul acte irréversible du produit. Ce que ces tests protègent tient en
 * une phrase : rien ne se détruit qui n'ait été énuméré, chiffré et daté
 * d'abord, et ce qui a été autorisé est exactement ce qui est détruit.
 */
describe('purge', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let passwordHash: string;
  let storageDir: string;
  let banque: string;
  let microfinance: string;
  let audio: Uint8Array;

  beforeAll(async () => {
    storageDir = process.env.STORAGE_DIR as string;
    prisma = createTestPrisma();
    await prisma.$connect();
    passwordHash = await hashPassword(MOT_DE_PASSE);
    app = await createTestApp();
    audio = buildWavPcm({ samples: new Int16Array(INGEST_SAMPLE_RATE) });
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

    for (const [email, tenantId, role] of [
      ['admin@a.cm', banque, 'ADMIN'],
      ['superviseur@a.cm', banque, 'SUPERVISOR'],
      ['auditeur@a.cm', banque, 'AUDITOR'],
      ['admin@b.cm', microfinance, 'ADMIN'],
    ] as const) {
      await prisma.user.create({ data: { tenantId, email, passwordHash, role } });
    }

    // Conservation courte : les appels de démonstration franchissent
    // l'échéance sans qu'il faille fabriquer des dates d'il y a deux ans.
    await prisma.retentionPolicy.create({
      data: { tenantId: banque, appliesTo: 'all', days: 30 },
    });
  });

  let compteur = 0;

  /** Un appel rangé, fichier compris : la purge doit vraiment détruire. */
  async function creerAppel(tenantId: string, ilYaJours: number) {
    compteur += 1;
    const startedAt = new Date();
    startedAt.setUTCDate(startedAt.getUTCDate() - ilYaJours);

    const filePath = `${tenantId}/2026/09/appel-${compteur}.wav`;
    const chemin = join(storageDir, filePath);
    await mkdir(dirname(chemin), { recursive: true });
    await writeFile(chemin, audio);

    const recording = await prisma.recording.create({
      data: {
        tenantId,
        refci: `2000000${compteur}`,
        near: '1001',
        far: '699112233',
        direction: 'outbound',
        startedAt,
        durationSec: 60,
        filePath,
        sha256: createHash('sha256').update(audio).digest('hex'),
        sizeBytes: BigInt(audio.byteLength),
        source: 'simulator',
      },
    });
    return { ...recording, chemin };
  }

  async function jeton(email: string): Promise<string> {
    const reponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: MOT_DE_PASSE })
      .expect(200);
    return (reponse.body as { accessToken: string }).accessToken;
  }

  const avec = (token: string) => ({
    get: (url: string) =>
      request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) =>
      request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${token}`),
  });

  const existe = async (chemin: string): Promise<boolean> =>
    access(chemin).then(
      () => true,
      () => false,
    );

  describe('le rapport', () => {
    it('énumère les appels échus, et ignore ceux qui ne le sont pas', async () => {
      await creerAppel(banque, 90);
      await creerAppel(banque, 60);
      await creerAppel(banque, 5); // dans la durée de conservation

      const reponse = await avec(await jeton('superviseur@a.cm'))
        .post('/api/purge/reports')
        .expect(201);

      expect(reponse.body).toMatchObject({
        status: 'simulated',
        policyDays: 30,
        candidateCount: 2,
        blockedCount: 0,
        createdByEmail: 'superviseur@a.cm',
        executedAt: null,
      });
      expect(reponse.body.candidateBytes).toBe(audio.byteLength * 2);
    });

    it('ne détruit rien : c’est une lecture, pas un acte', async () => {
      const appel = await creerAppel(banque, 90);
      await avec(await jeton('admin@a.cm'))
        .post('/api/purge/reports')
        .expect(201);

      expect(await existe(appel.chemin)).toBe(true);
      expect((await prisma.recording.findFirstOrThrow({ where: { id: appel.id } })).status).toBe(
        'stored',
      );
      expect(await prisma.auditEvent.count({ where: { action: 'PURGE' } })).toBe(0);
    });

    it('montre ce qu’une conservation forcée épargne, et pourquoi', async () => {
      const garde = await creerAppel(banque, 90);
      await creerAppel(banque, 90);

      const admin = await jeton('admin@a.cm');
      await avec(admin)
        .post(`/api/recordings/${garde.id}/holds`)
        .send({ reason: MOTIF_HOLD, caseReference: 'REQ-2026-118' })
        .expect(201);

      const rapport = await avec(admin).post('/api/purge/reports').expect(201);
      expect(rapport.body).toMatchObject({ candidateCount: 1, blockedCount: 1 });
      expect(rapport.body.blockedBytes).toBe(audio.byteLength);

      const detail = await avec(admin).get(`/api/purge/reports/${rapport.body.id}`).expect(200);
      const epargne = detail.body.items.find((item: { blocked: boolean }) => item.blocked);
      // Le motif figure sur le rapport : il se lit sans autre source.
      expect(epargne).toMatchObject({
        recordingId: garde.id,
        blocked: true,
        blockingReason: MOTIF_HOLD,
        outcome: 'blocked',
      });
    });

    it('se lit ligne à ligne, avec de quoi identifier chaque appel', async () => {
      const appel = await creerAppel(banque, 90);
      const rapport = await avec(await jeton('admin@a.cm'))
        .post('/api/purge/reports')
        .expect(201);

      const detail = await avec(await jeton('auditeur@a.cm'))
        .get(`/api/purge/reports/${rapport.body.id}`)
        .expect(200);

      expect(detail.body.itemsTotal).toBe(1);
      expect(detail.body.items[0]).toMatchObject({
        recordingId: appel.id,
        refci: appel.refci,
        near: appel.near,
        far: appel.far,
        sha256: appel.sha256,
        sizeBytes: audio.byteLength,
        outcome: 'candidate',
        blocked: false,
      });
    });

    it('sépare les deux questions : ce qu’on détruit, ce qu’on épargne', async () => {
      const garde = await creerAppel(banque, 90);
      await creerAppel(banque, 90);
      const admin = await jeton('admin@a.cm');
      await avec(admin)
        .post(`/api/recordings/${garde.id}/holds`)
        .send({ reason: MOTIF_HOLD, caseReference: 'REQ-2026-118' })
        .expect(201);

      const rapport = await avec(admin).post('/api/purge/reports').expect(201);
      const id = rapport.body.id;

      const bloques = await avec(admin).get(`/api/purge/reports/${id}?blocked=true`).expect(200);
      expect(bloques.body.itemsTotal).toBe(1);
      expect(bloques.body.items[0].recordingId).toBe(garde.id);

      const candidats = await avec(admin).get(`/api/purge/reports/${id}?blocked=false`).expect(200);
      expect(candidats.body.itemsTotal).toBe(1);
      expect(candidats.body.items[0].recordingId).not.toBe(garde.id);
    });

    it('se retrouve dans la liste des rapports, le plus récent en tête', async () => {
      await creerAppel(banque, 90);
      const admin = await jeton('admin@a.cm');
      await avec(admin).post('/api/purge/reports').expect(201);
      await avec(admin).post('/api/purge/reports').expect(201);

      const liste = await avec(await jeton('auditeur@a.cm'))
        .get('/api/purge/reports')
        .expect(200);
      expect(liste.body.total).toBe(2);
      expect(liste.body.items[0].status).toBe('simulated');
    });

    it('refuse qu’un AUDITOR en établisse un', async () => {
      await avec(await jeton('auditeur@a.cm'))
        .post('/api/purge/reports')
        .expect(403);
    });

    it('ne voit pas les appels d’un autre locataire', async () => {
      await creerAppel(microfinance, 90);
      const rapport = await avec(await jeton('admin@a.cm'))
        .post('/api/purge/reports')
        .expect(201);
      expect(rapport.body).toMatchObject({ candidateCount: 0, blockedCount: 0 });
    });

    it('ne se lit pas depuis un autre locataire', async () => {
      await creerAppel(banque, 90);
      const rapport = await avec(await jeton('admin@a.cm'))
        .post('/api/purge/reports')
        .expect(201);

      await avec(await jeton('admin@b.cm'))
        .get(`/api/purge/reports/${rapport.body.id}`)
        .expect(404);
    });
  });

  describe('l’exécution', () => {
    async function rapportPret() {
      const appels = [await creerAppel(banque, 90), await creerAppel(banque, 60)];
      const rapport = await avec(await jeton('admin@a.cm'))
        .post('/api/purge/reports')
        .expect(201);
      return { appels, id: rapport.body.id as string };
    }

    it('détruit le fichier, garde la ligne, et laisse l’empreinte au journal', async () => {
      const { appels, id } = await rapportPret();

      const reponse = await avec(await jeton('admin@a.cm'))
        .post(`/api/purge/reports/${id}/execute`)
        .send({ reason: MOTIF_PURGE })
        .expect(200);

      expect(reponse.body).toMatchObject({
        status: 'executed',
        purgedCount: 2,
        executedByEmail: 'admin@a.cm',
      });
      expect(reponse.body.purgedBytes).toBe(audio.byteLength * 2);

      for (const appel of appels) {
        expect(await existe(appel.chemin)).toBe(false);

        // La ligne subsiste : elle est la trace de ce qui a existé et de ce
        // qui a été détruit (§9.7).
        const enBase = await prisma.recording.findFirstOrThrow({ where: { id: appel.id } });
        expect(enBase.status).toBe('purged');
        expect(enBase.sha256).toBe(appel.sha256);
        expect(enBase.sizeBytes).toBe(appel.sizeBytes);
        expect(enBase.filePath).toBe(appel.filePath);
      }

      const traces = await prisma.auditEvent.findMany({ where: { action: 'PURGE' } });
      expect(traces).toHaveLength(2);
      expect(traces[0]?.detail).toMatchObject({
        motif: MOTIF_PURGE,
        rapportId: id,
        politiqueJours: 30,
        sha256: appels.find((a) => a.id === traces[0]?.recordingId)?.sha256,
      });
    });

    it('épargne ce que le rapport a marqué comme sous conservation forcée', async () => {
      const garde = await creerAppel(banque, 90);
      const condamne = await creerAppel(banque, 90);
      const admin = await jeton('admin@a.cm');
      await avec(admin)
        .post(`/api/recordings/${garde.id}/holds`)
        .send({ reason: MOTIF_HOLD, caseReference: 'REQ-2026-118' })
        .expect(201);

      const rapport = await avec(admin).post('/api/purge/reports').expect(201);
      await avec(admin)
        .post(`/api/purge/reports/${rapport.body.id}/execute`)
        .send({ reason: MOTIF_PURGE })
        .expect(200);

      expect(await existe(garde.chemin)).toBe(true);
      expect((await prisma.recording.findFirstOrThrow({ where: { id: garde.id } })).status).toBe(
        'stored',
      );
      expect(await existe(condamne.chemin)).toBe(false);
    });

    it('refuse d’exécuter si une conservation forcée est posée depuis le rapport', async () => {
      const { appels, id } = await rapportPret();
      const admin = await jeton('admin@a.cm');

      // Le hold arrive après la lecture du rapport : l'autorisation ne porte
      // plus sur ce qui serait détruit.
      await avec(admin)
        .post(`/api/recordings/${appels[0]!.id}/holds`)
        .send({ reason: MOTIF_HOLD, caseReference: 'REQ-2026-118' })
        .expect(201);

      const refus = await avec(admin)
        .post(`/api/purge/reports/${id}/execute`)
        .send({ reason: MOTIF_PURGE })
        .expect(409);
      expect(JSON.stringify(refus.body)).toMatch(/ont changé depuis ce rapport/);

      for (const appel of appels) expect(await existe(appel.chemin)).toBe(true);
      expect(await prisma.auditEvent.count({ where: { action: 'PURGE' } })).toBe(0);
    });

    it('refuse d’exécuter si un appel a franchi l’échéance depuis le rapport', async () => {
      const { id } = await rapportPret();
      // Un appel de plus, déjà échu : le rapport ne l'énumérait pas.
      await creerAppel(banque, 120);

      await avec(await jeton('admin@a.cm'))
        .post(`/api/purge/reports/${id}/execute`)
        .send({ reason: MOTIF_PURGE })
        .expect(409);
    });

    it('refuse d’exécuter si la conservation a changé depuis le rapport', async () => {
      const { id } = await rapportPret();
      const admin = await jeton('admin@a.cm');

      await request(app.getHttpServer())
        .put('/api/retention')
        .set('Authorization', `Bearer ${admin}`)
        .send({ days: 1095 })
        .expect(200);

      const refus = await avec(admin)
        .post(`/api/purge/reports/${id}/execute`)
        .send({ reason: MOTIF_PURGE })
        .expect(409);
      expect(JSON.stringify(refus.body)).toMatch(
        /conservation est passée à générale 30 jours → 1095 jours/,
      );
    });

    it('ne s’exécute pas deux fois', async () => {
      const { id } = await rapportPret();
      const admin = await jeton('admin@a.cm');
      await avec(admin)
        .post(`/api/purge/reports/${id}/execute`)
        .send({ reason: MOTIF_PURGE })
        .expect(200);
      await avec(admin)
        .post(`/api/purge/reports/${id}/execute`)
        .send({ reason: MOTIF_PURGE })
        .expect(409);
      expect(await prisma.auditEvent.count({ where: { action: 'PURGE' } })).toBe(2);
    });

    it('refuse qu’un SUPERVISOR ou un AUDITOR détruise', async () => {
      const { appels, id } = await rapportPret();
      for (const email of ['superviseur@a.cm', 'auditeur@a.cm']) {
        await avec(await jeton(email))
          .post(`/api/purge/reports/${id}/execute`)
          .send({ reason: MOTIF_PURGE })
          .expect(403);
      }
      for (const appel of appels) expect(await existe(appel.chemin)).toBe(true);
    });

    it('exige un motif lisible', async () => {
      const { id } = await rapportPret();
      await avec(await jeton('admin@a.cm'))
        .post(`/api/purge/reports/${id}/execute`)
        .send({ reason: 'rien' })
        .expect(400);
      expect(await prisma.auditEvent.count({ where: { action: 'PURGE' } })).toBe(0);
    });

    it('consigne le fichier déjà absent plutôt que d’échouer', async () => {
      const { appels, id } = await rapportPret();
      // Le disque a perdu une pièce entre le rapport et l'exécution.
      await rm(appels[0]!.chemin);

      const reponse = await avec(await jeton('admin@a.cm'))
        .post(`/api/purge/reports/${id}/execute`)
        .send({ reason: MOTIF_PURGE })
        .expect(200);
      expect(reponse.body.purgedCount).toBe(2);

      const trace = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'PURGE', recordingId: appels[0]!.id },
      });
      expect(trace.detail).toMatchObject({ fichierDejaAbsent: true });

      const item = await prisma.purgeRunItem.findFirstOrThrow({
        where: { purgeRunId: id, recordingId: appels[0]!.id },
      });
      expect(item.outcome).toBe('missing');
    });

    it('un rapport annulé ne s’exécute plus', async () => {
      const { appels, id } = await rapportPret();
      const admin = await jeton('admin@a.cm');

      const annule = await avec(admin).post(`/api/purge/reports/${id}/cancel`).expect(200);
      expect(annule.body).toMatchObject({ status: 'cancelled', cancelledByEmail: 'admin@a.cm' });

      await avec(admin)
        .post(`/api/purge/reports/${id}/execute`)
        .send({ reason: MOTIF_PURGE })
        .expect(409);
      for (const appel of appels) expect(await existe(appel.chemin)).toBe(true);
    });

    it('ne s’exécute pas depuis un autre locataire', async () => {
      const { appels, id } = await rapportPret();
      await avec(await jeton('admin@b.cm'))
        .post(`/api/purge/reports/${id}/execute`)
        .send({ reason: MOTIF_PURGE })
        .expect(404);
      for (const appel of appels) expect(await existe(appel.chemin)).toBe(true);
    });

    it('laisse un appel purgé introuvable à l’écoute, sans effacer sa fiche', async () => {
      const { appels, id } = await rapportPret();
      const admin = await jeton('admin@a.cm');
      await avec(admin)
        .post(`/api/purge/reports/${id}/execute`)
        .send({ reason: MOTIF_PURGE })
        .expect(200);

      // L'appel reste dans la recherche — avec son empreinte — mais on ne
      // peut plus l'écouter : c'est exactement ce que « purgé » veut dire.
      const liste = await avec(admin).get('/api/recordings').expect(200);
      expect(liste.body.total).toBe(2);
      expect(liste.body.items[0].status).toBe('purged');

      await avec(admin).post(`/api/recordings/${appels[0]!.id}/listen`).expect(410);
    });
  });
});
