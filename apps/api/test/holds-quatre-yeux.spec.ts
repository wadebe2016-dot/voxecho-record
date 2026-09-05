import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { LegalHoldResponse, PurgeReportSummary } from '@voxecho/shared';
import { hashPassword } from '../src/auth/password';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026-portail';
const MOTIF = 'Réquisition judiciaire, pièce à conserver jusqu’au jugement.';
const DOSSIER = 'REQ-2026-118 / parquet de Douala';

/**
 * Conservation forcée : référence de dossier et contre-validation —
 * CLAUDE.md §9.29.
 *
 * Poser une conservation protège une preuve ; la lever la rend destructible.
 * Ce que ces cas vérifient tient en une phrase : la levée ne doit jamais
 * dépendre de la seule personne qui a posé, et un appel protégé ne doit jamais
 * se retrouver candidat à la purge.
 */
describe('conservation forcée à quatre yeux', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let banque: string;
  let appelId: string;

  async function jeton(email: string): Promise<string> {
    const reponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: MOT_DE_PASSE })
      .expect(200);
    return (reponse.body as { accessToken: string }).accessToken;
  }

  function avec(jetonAcces: string) {
    return {
      poser: (corps: Record<string, unknown>) =>
        request(app.getHttpServer())
          .post(`/api/recordings/${appelId}/holds`)
          .set('Authorization', `Bearer ${jetonAcces}`)
          .send(corps),
      lever: (corps: Record<string, unknown>) =>
        request(app.getHttpServer())
          .post(`/api/recordings/${appelId}/holds/release`)
          .set('Authorization', `Bearer ${jetonAcces}`)
          .send(corps),
      historique: () =>
        request(app.getHttpServer())
          .get(`/api/recordings/${appelId}/holds`)
          .set('Authorization', `Bearer ${jetonAcces}`),
    };
  }

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    app = await createTestApp();
  });

  afterAll(async () => {
    await resetTestData(prisma);
    await prisma.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await resetTestData(prisma);
    banque = (await prisma.tenant.create({ data: { name: 'Banque A', slug: 'banque-a' } })).id;
    const passwordHash = await hashPassword(MOT_DE_PASSE);
    await prisma.user.create({
      data: { tenantId: banque, email: 'admin@a.cm', passwordHash, role: 'ADMIN' },
    });

    const ancien = new Date();
    ancien.setUTCFullYear(ancien.getUTCFullYear() - 5);
    appelId = (
      await prisma.recording.create({
        data: {
          tenantId: banque,
          refci: '16778001',
          near: '1001',
          far: '699112233',
          direction: 'outbound',
          startedAt: ancien,
          durationSec: 120,
          filePath: `${banque}/2021/09/appel.wav`,
          sha256: 'a'.repeat(64),
          sizeBytes: BigInt(1_920_000),
          source: 'simulator',
        },
      })
    ).id;
  });

  /** Un second administrateur, quand le cas l'exige. */
  async function secondAdministrateur(): Promise<string> {
    await prisma.user.create({
      data: {
        tenantId: banque,
        email: 'admin2@a.cm',
        passwordHash: await hashPassword(MOT_DE_PASSE),
        role: 'ADMIN',
      },
    });
    return jeton('admin2@a.cm');
  }

  describe('pose', () => {
    it('exige la référence du dossier autant que le motif', async () => {
      const admin = await jeton('admin@a.cm');
      await avec(admin).poser({ reason: MOTIF }).expect(400);
      await avec(admin).poser({ reason: MOTIF, caseReference: 'X' }).expect(400);

      const pose = await avec(admin).poser({ reason: MOTIF, caseReference: DOSSIER }).expect(201);
      expect((pose.body as LegalHoldResponse).caseReference).toBe(DOSSIER);
    });

    it('inscrit le dossier au journal, pour qu’il se lise sans autre source', async () => {
      await avec(await jeton('admin@a.cm'))
        .poser({ reason: MOTIF, caseReference: DOSSIER })
        .expect(201);

      const trace = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'HOLD_SET' } });
      expect(trace.detail).toMatchObject({ dossier: DOSSIER, motif: MOTIF });
    });
  });

  describe('levée', () => {
    it('refuse que celui qui a posé lève seul, quand un autre administrateur existe', async () => {
      const admin = await jeton('admin@a.cm');
      await avec(admin).poser({ reason: MOTIF, caseReference: DOSSIER }).expect(201);
      const second = await secondAdministrateur();

      // Le cœur de la règle : défaire seul ce qu'on a seul décidé rendrait la
      // conservation forcée aussi solide que la volonté d'une personne.
      const refus = await avec(admin)
        .lever({ reason: 'Contentieux clos, pièce libérée.' })
        .expect(400);
      expect((refus.body as { message: string }).message).toMatch(/un autre administrateur/i);

      // Même en l'assumant : la porte de sortie n'existe que faute de second.
      await avec(admin)
        .lever({ reason: 'Contentieux clos, pièce libérée.', acceptSansContreValidation: true })
        .expect(400);

      const levee = await avec(second)
        .lever({ reason: 'Contentieux clos, jugement rendu le 30/08/2026.' })
        .expect(201);
      expect((levee.body as LegalHoldResponse).releasedWithoutSecondApproval).toBe(false);
    });

    it('laisse un administrateur lever la conservation posée par un autre', async () => {
      const admin = await jeton('admin@a.cm');
      const second = await secondAdministrateur();
      await avec(second).poser({ reason: MOTIF, caseReference: DOSSIER }).expect(201);

      await avec(admin).lever({ reason: 'Contentieux clos, pièce libérée.' }).expect(201);
    });

    it('accepte la levée sans second administrateur, mais l’exige assumée et la consigne', async () => {
      const admin = await jeton('admin@a.cm');
      await avec(admin).poser({ reason: MOTIF, caseReference: DOSSIER }).expect(201);

      // Sans porte de sortie, une instance à un seul administrateur ne pourrait
      // plus jamais lever une conservation devenue sans objet.
      const refus = await avec(admin)
        .lever({ reason: 'Contentieux clos, pièce libérée.' })
        .expect(400);
      expect((refus.body as { message: string }).message).toMatch(/acceptée explicitement/i);

      const levee = await avec(admin)
        .lever({ reason: 'Contentieux clos, pièce libérée.', acceptSansContreValidation: true })
        .expect(201);
      expect((levee.body as LegalHoldResponse).releasedWithoutSecondApproval).toBe(true);

      const trace = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'HOLD_RELEASE' } });
      expect(trace.detail).toMatchObject({ contreValidation: 'levée sans contre-validation' });
    });

    it('ne compte pas un administrateur désactivé comme second', async () => {
      const admin = await jeton('admin@a.cm');
      await avec(admin).poser({ reason: MOTIF, caseReference: DOSSIER }).expect(201);
      await secondAdministrateur();
      await prisma.user.update({ where: { email: 'admin2@a.cm' }, data: { active: false } });

      // Un compte fermé ne contre-valide rien : la porte de sortie se rouvre.
      await avec(admin)
        .lever({ reason: 'Contentieux clos, pièce libérée.', acceptSansContreValidation: true })
        .expect(201);
    });
  });

  describe('protection contre la purge', () => {
    it('n’énumère jamais un appel protégé parmi les candidats, même largement échu', async () => {
      const admin = await jeton('admin@a.cm');
      await avec(admin).poser({ reason: MOTIF, caseReference: DOSSIER }).expect(201);

      const rapport = (
        await request(app.getHttpServer())
          .post('/api/purge/reports')
          .set('Authorization', `Bearer ${admin}`)
          .expect(201)
      ).body as PurgeReportSummary;

      // L'appel a cinq ans, la conservation est de deux : il serait purgeable
      // sans la conservation forcée.
      expect(rapport.candidateCount).toBe(0);
      expect(rapport.blockedCount).toBe(1);

      const detail = (
        await request(app.getHttpServer())
          .get(`/api/purge/reports/${rapport.id}`)
          .set('Authorization', `Bearer ${admin}`)
          .expect(200)
      ).body as {
        items: { recordingId: string; blocked: boolean; blockingReason: string | null }[];
      };

      const ligne = detail.items.find((item) => item.recordingId === appelId);
      expect(ligne).toMatchObject({ blocked: true });
      expect(ligne?.blockingReason).toMatch(/Réquisition judiciaire/);
    });

    it('reste intact après une exécution de purge', async () => {
      const admin = await jeton('admin@a.cm');
      await avec(admin).poser({ reason: MOTIF, caseReference: DOSSIER }).expect(201);

      const rapport = (
        await request(app.getHttpServer())
          .post('/api/purge/reports')
          .set('Authorization', `Bearer ${admin}`)
          .expect(201)
      ).body as PurgeReportSummary;

      await request(app.getHttpServer())
        .post(`/api/purge/reports/${rapport.id}/execute`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ reason: 'Échéance atteinte, validée par la conformité' })
        .expect(200);

      const apres = await prisma.recording.findUniqueOrThrow({ where: { id: appelId } });
      expect(apres.status).toBe('stored');
      expect(await prisma.auditEvent.count({ where: { action: 'PURGE' } })).toBe(0);
    });
  });
});
