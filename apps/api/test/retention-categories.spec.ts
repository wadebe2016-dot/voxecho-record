import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { PurgeReportSummary, RetentionPolicySetResponse } from '@voxecho/shared';
import { hashPassword } from '../src/auth/password';
import { RetentionService } from '../src/retention/retention.service';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026-portail';

/**
 * Conservation par catégorie d'opération — CLAUDE.md §9.28.
 *
 * Le §9.10 avait posé la catégorie en prévoyant qu'elle porterait un jour des
 * durées différenciées : une confirmation de chèque et un ordre de change
 * n'engagent pas la banque de la même façon. Ce qui se vérifie ici, c'est que
 * la durée la plus précise s'applique, que le plancher continue de protéger, et
 * que la purge respecte chaque échéance plutôt qu'une moyenne.
 */
describe('conservation par catégorie', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let banque: string;
  let retention: RetentionService;

  async function jeton(email: string): Promise<string> {
    const reponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: MOT_DE_PASSE })
      .expect(200);
    return (reponse.body as { accessToken: string }).accessToken;
  }

  function definir(corps: Record<string, unknown>, jetonAcces: string) {
    return request(app.getHttpServer())
      .put('/api/retention')
      .set('Authorization', `Bearer ${jetonAcces}`)
      .send(corps);
  }

  /** Un appel d'une catégorie donnée, vieilli du nombre de jours voulu. */
  async function appel(categorie: string, joursAvant: number): Promise<string> {
    const debut = new Date();
    debut.setUTCDate(debut.getUTCDate() - joursAvant);
    const cree = await prisma.recording.create({
      data: {
        tenantId: banque,
        refci: `${categorie}-${joursAvant}`,
        near: '1001',
        far: '699112233',
        direction: 'outbound',
        startedAt: debut,
        durationSec: 60,
        filePath: `${banque}/2026/09/${categorie}-${joursAvant}.wav`,
        sha256: 'a'.repeat(64),
        sizeBytes: BigInt(960_000),
        source: 'simulator',
        operationCategory: categorie,
      },
    });
    return cree.id;
  }

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    app = await createTestApp();
    retention = app.get(RetentionService);
  });

  afterAll(async () => {
    await resetTestData(prisma);
    await prisma.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await resetTestData(prisma);
    banque = (await prisma.tenant.create({ data: { name: 'Banque A', slug: 'banque-a' } })).id;
    await prisma.user.create({
      data: {
        tenantId: banque,
        email: 'admin@a.cm',
        passwordHash: await hashPassword(MOT_DE_PASSE),
        role: 'ADMIN',
      },
    });
  });

  it('fait suivre la générale à toute catégorie sans politique propre', async () => {
    const ensemble = (
      await request(app.getHttpServer())
        .get('/api/retention/ensemble')
        .set('Authorization', `Bearer ${await jeton('admin@a.cm')}`)
        .expect(200)
    ).body as RetentionPolicySetResponse;

    expect(ensemble.generale).toMatchObject({ days: 730, enregistree: false });
    // Une catégorie sans politique n'est pas une catégorie sans conservation :
    // elle suit la générale, et l'écran le dira plutôt que d'afficher un vide.
    expect(ensemble.parCategorie).toHaveLength(3);
    for (const entree of ensemble.parCategorie) {
      expect(entree).toMatchObject({ days: 730, enregistree: false });
    }
  });

  it('applique la durée la plus précise, qu’elle allonge ou qu’elle raccourcisse', async () => {
    const admin = await jeton('admin@a.cm');
    await definir({ days: 3650, appliesTo: 'operation_change' }, admin).expect(200);
    await definir(
      { days: 365, appliesTo: 'autre', belowFloorReason: 'Appels internes sans enjeu bancaire' },
      admin,
    ).expect(200);

    // C'est l'usage attendu : dix ans pour les ordres de change, un an pour le
    // reste. Retenir « la plus longue » aurait rendu le raccourcissement
    // impossible, donc la politique de catégorie inutile.
    expect(await retention.joursApplicables(banque, 'operation_change')).toBe(3650);
    expect(await retention.joursApplicables(banque, 'autre')).toBe(365);
    expect(await retention.joursApplicables(banque, 'confirmation_cheque')).toBe(730);
    expect(await retention.joursApplicables(banque, null)).toBe(730);
  });

  it('exige un motif sous le plancher, pour une catégorie comme pour la générale', async () => {
    const admin = await jeton('admin@a.cm');
    // Ce qui protège d'un raccourcissement discret n'est pas la règle de
    // priorité mais le plancher de l'instance (§9.6).
    await definir({ days: 90, appliesTo: 'autre' }, admin).expect(400);
    await definir(
      { days: 90, appliesTo: 'autre', belowFloorReason: 'Décision du comité du 3 septembre' },
      admin,
    ).expect(200);
  });

  it('refuse un périmètre que le contrat ne connaît pas', async () => {
    const admin = await jeton('admin@a.cm');
    // Même règle qu'au §9.10 : une catégorie inconnue est une faute de frappe.
    const reponse = await definir({ days: 1000, appliesTo: 'confirmation_chèque' }, admin).expect(
      400,
    );
    expect((reponse.body as { message: string }).message).toMatch(/Périmètre inconnu/);
  });

  it('inscrit le périmètre au journal, avec l’avant et l’après', async () => {
    await definir({ days: 3650, appliesTo: 'operation_change' }, await jeton('admin@a.cm')).expect(
      200,
    );

    const trace = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'RETENTION_SET' },
      orderBy: { at: 'desc' },
    });
    expect(trace.detail).toMatchObject({
      perimetre: 'operation_change',
      avantJours: 730,
      apresJours: 3650,
      raccourcie: false,
    });
  });

  describe('purge', () => {
    it('n’emporte que ce qui est échu au regard de sa propre catégorie', async () => {
      const admin = await jeton('admin@a.cm');
      await definir(
        { days: 30, appliesTo: 'autre', belowFloorReason: 'Appels internes sans enjeu bancaire' },
        admin,
      ).expect(200);
      await definir({ days: 3650, appliesTo: 'operation_change' }, admin).expect(200);

      const banal = await appel('autre', 60);
      const change = await appel('operation_change', 60);
      const cheque = await appel('confirmation_cheque', 60);

      const rapport = (
        await request(app.getHttpServer())
          .post('/api/purge/reports')
          .set('Authorization', `Bearer ${admin}`)
          .expect(201)
      ).body as PurgeReportSummary;

      // Seul l'appel « autre » a dépassé ses trente jours : les deux autres
      // sont protégés par leur propre durée, non par une moyenne.
      expect(rapport.candidateCount).toBe(1);
      const detail = (
        await request(app.getHttpServer())
          .get(`/api/purge/reports/${rapport.id}`)
          .set('Authorization', `Bearer ${admin}`)
          .expect(200)
      ).body as { items: { recordingId: string }[] };
      expect(detail.items.map((item) => item.recordingId)).toEqual([banal]);
      expect(detail.items.map((item) => item.recordingId)).not.toContain(change);
      expect(detail.items.map((item) => item.recordingId)).not.toContain(cheque);
    });

    it('refuse d’exécuter un rapport dont une durée de catégorie a bougé', async () => {
      const admin = await jeton('admin@a.cm');
      await definir(
        { days: 30, appliesTo: 'autre', belowFloorReason: 'Appels internes sans enjeu bancaire' },
        admin,
      ).expect(200);
      await appel('autre', 60);

      const rapport = (
        await request(app.getHttpServer())
          .post('/api/purge/reports')
          .set('Authorization', `Bearer ${admin}`)
          .expect(201)
      ).body as PurgeReportSummary;

      // Le rapport est l'autorisation : si une durée change, ce qui serait
      // détruit n'est plus ce qui a été autorisé (§9.7).
      await definir({ days: 3650, appliesTo: 'operation_change' }, admin).expect(200);
      const refus = await request(app.getHttpServer())
        .post(`/api/purge/reports/${rapport.id}/execute`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ reason: 'Échéance atteinte, validée par la conformité' })
        .expect(409);

      expect((refus.body as { message: string }).message).toMatch(
        /catégorie operation_change suit la générale → 3650 jours/,
      );
    });
  });
});
