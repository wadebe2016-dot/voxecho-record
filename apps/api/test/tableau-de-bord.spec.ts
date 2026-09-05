import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { DASHBOARD_JOURS, DASHBOARD_QUARANTAINES } from '@voxecho/shared';
import { hashPassword } from '../src/auth/password';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026';

/**
 * Tableau de bord — CLAUDE.md §6 et §9.12.
 *
 * Des chiffres d'exploitation : ce que pèse la conservation, si la chaîne de
 * capture tourne. Rien n'y dit qui a écouté quoi — c'est le journal d'audit
 * qui le dit, et lui seul.
 */
describe('tableau de bord', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let passwordHash: string;
  let banque: string;
  let microfinance: string;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    passwordHash = await hashPassword(MOT_DE_PASSE);
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
    microfinance = (await prisma.tenant.create({ data: { name: 'MFI B', slug: 'mfi-b' } })).id;

    for (const [email, tenantId, role] of [
      ['admin@a.cm', banque, 'ADMIN'],
      ['superviseur@a.cm', banque, 'SUPERVISOR'],
      ['auditeur@a.cm', banque, 'AUDITOR'],
      ['admin@b.cm', microfinance, 'ADMIN'],
    ] as const) {
      await prisma.user.create({ data: { tenantId, email, passwordHash, role } });
    }
  });

  let compteur = 0;
  async function creerAppel(
    tenantId: string,
    options: {
      ilYaJours?: number;
      dureeSec?: number;
      octets?: number;
      statut?: 'stored' | 'purged';
    } = {},
  ) {
    compteur += 1;
    const startedAt = new Date();
    startedAt.setUTCDate(startedAt.getUTCDate() - (options.ilYaJours ?? 0));
    // Milieu de journée : à minuit, une heure de décalage ferait basculer
    // l'appel dans la veille et rendrait le test capricieux.
    startedAt.setUTCHours(12, 0, 0, 0);

    return prisma.recording.create({
      data: {
        tenantId,
        refci: `3000000${compteur}`,
        near: '1001',
        far: '699112233',
        direction: 'outbound',
        startedAt,
        durationSec: options.dureeSec ?? 60,
        filePath: `${tenantId}/2026/09/appel-${compteur}.wav`,
        sha256: `sha-${compteur}`.padEnd(64, '0'),
        sizeBytes: BigInt(options.octets ?? 960_000),
        source: 'simulator',
        status: options.statut ?? 'stored',
      },
    });
  }

  async function jeton(email: string): Promise<string> {
    const reponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: MOT_DE_PASSE })
      .expect(200);
    return (reponse.body as { accessToken: string }).accessToken;
  }

  /**
   * Rendue synchrone : `await` sur une requête supertest la lance, et un
   * helper `async` la lancerait avant que l'appelant ait pu y accrocher son
   * `.expect()`.
   */
  const lire = (token: string) =>
    request(app.getHttpServer()).get('/api/dashboard').set('Authorization', `Bearer ${token}`);

  describe('les totaux', () => {
    it('comptent les appels conservés, leur durée et ce qu’ils pèsent', async () => {
      await creerAppel(banque, { dureeSec: 120, octets: 1_920_000 });
      await creerAppel(banque, { dureeSec: 60, octets: 960_000 });

      const reponse = await lire(await jeton('auditeur@a.cm')).expect(200);
      expect(reponse.body.totaux).toMatchObject({
        appelsConserves: 2,
        dureeSec: 180,
        stockageOctets: 2_880_000,
        appelsPurges: 0,
      });
    });

    it('excluent du stockage ce qui a été purgé, sans oublier de le compter', async () => {
      await creerAppel(banque, { octets: 960_000 });
      await creerAppel(banque, { octets: 5_000_000, statut: 'purged' });

      const reponse = await lire(await jeton('auditeur@a.cm')).expect(200);
      // Un appel purgé garde sa fiche mais ne pèse plus rien (§9.7).
      expect(reponse.body.totaux).toMatchObject({
        appelsConserves: 1,
        stockageOctets: 960_000,
        appelsPurges: 1,
      });
    });

    it('comptent les appels sous conservation forcée', async () => {
      const appel = await creerAppel(banque);
      await creerAppel(banque);
      await request(app.getHttpServer())
        .post(`/api/recordings/${appel.id}/holds`)
        .set('Authorization', `Bearer ${await jeton('admin@a.cm')}`)
        .send({ reason: 'Contentieux 2026-114 : pièce réclamée.', caseReference: 'REQ-2026-118' })
        .expect(201);

      const reponse = await lire(await jeton('auditeur@a.cm')).expect(200);
      expect(reponse.body.totaux.sousConservationForcee).toBe(1);
    });

    it('rappellent la conservation en vigueur, dérogation comprise', async () => {
      await request(app.getHttpServer())
        .put('/api/retention')
        .set('Authorization', `Bearer ${await jeton('admin@a.cm')}`)
        .send({
          days: 90,
          belowFloorReason: 'Filiale cédée, conservation reprise par l’acquéreur.',
        })
        .expect(200);

      const reponse = await lire(await jeton('auditeur@a.cm')).expect(200);
      expect(reponse.body.retention).toMatchObject({
        days: 90,
        belowFloorReason: 'Filiale cédée, conservation reprise par l’acquéreur.',
      });
    });
  });

  describe('le volume par jour', () => {
    it('couvre la fenêtre entière, jours creux compris', async () => {
      await creerAppel(banque, { ilYaJours: 1 });

      const reponse = await lire(await jeton('auditeur@a.cm')).expect(200);
      const jours = reponse.body.volumeParJour;

      // Un graphe qui saute les jours creux dessine une activité continue là
      // où le service a chômé.
      expect(jours).toHaveLength(DASHBOARD_JOURS);
      expect(jours.filter((j: { appels: number }) => j.appels === 0).length).toBe(
        DASHBOARD_JOURS - 1,
      );
    });

    it('range les jours du plus ancien au plus récent', async () => {
      const reponse = await lire(await jeton('auditeur@a.cm')).expect(200);
      const jours = reponse.body.volumeParJour.map((j: { jour: string }) => j.jour);
      expect([...jours].sort()).toEqual(jours);
    });

    it('additionne les appels d’une même journée', async () => {
      await creerAppel(banque, { ilYaJours: 2, dureeSec: 30 });
      await creerAppel(banque, { ilYaJours: 2, dureeSec: 90 });

      const reponse = await lire(await jeton('auditeur@a.cm')).expect(200);
      const charge = reponse.body.volumeParJour.filter((j: { appels: number }) => j.appels > 0);
      expect(charge).toHaveLength(1);
      expect(charge[0]).toMatchObject({ appels: 2, dureeSec: 120 });
    });

    it('ignore ce qui est plus vieux que la fenêtre', async () => {
      await creerAppel(banque, { ilYaJours: DASHBOARD_JOURS + 5 });

      const reponse = await lire(await jeton('auditeur@a.cm')).expect(200);
      expect(reponse.body.volumeParJour.every((j: { appels: number }) => j.appels === 0)).toBe(
        true,
      );
      // L'appel reste compté au total : il est conservé, simplement ancien.
      expect(reponse.body.totaux.appelsConserves).toBe(1);
    });
  });

  describe('les dernières quarantaines', () => {
    it('rendent le motif tel qu’il a été consigné', async () => {
      await prisma.auditEvent.create({
        data: {
          tenantId: banque,
          action: 'QUARANTINE',
          detail: { motif: 'json malformé', radical: '20260901-143012' },
        },
      });

      const reponse = await lire(await jeton('auditeur@a.cm')).expect(200);
      expect(reponse.body.quarantaines).toHaveLength(1);
      expect(reponse.body.quarantaines[0].motif).toBe('json malformé');
    });

    it('s’en tiennent aux plus récentes', async () => {
      for (let n = 0; n < DASHBOARD_QUARANTAINES + 4; n += 1) {
        await prisma.auditEvent.create({
          data: { tenantId: banque, action: 'QUARANTINE', detail: { motif: `motif ${n}` } },
        });
      }

      const reponse = await lire(await jeton('auditeur@a.cm')).expect(200);
      expect(reponse.body.quarantaines).toHaveLength(DASHBOARD_QUARANTAINES);
    });

    it('taisent celles qu’aucun locataire ne réclame', async () => {
      // Réservées à l'ADMIN de l'instance, depuis le journal (§9.2).
      await prisma.auditEvent.create({
        data: { tenantId: null, action: 'QUARANTINE', detail: { motif: 'locataire inconnu' } },
      });

      const reponse = await lire(await jeton('admin@a.cm')).expect(200);
      expect(reponse.body.quarantaines).toHaveLength(0);
    });
  });

  describe('accès', () => {
    it.each(['admin@a.cm', 'superviseur@a.cm', 'auditeur@a.cm'])(
      'est ouvert à %s : ce sont des chiffres d’exploitation',
      async (email) => {
        await lire(await jeton(email)).expect(200);
      },
    );

    it('refuse une lecture non authentifiée', async () => {
      await request(app.getHttpServer()).get('/api/dashboard').expect(401);
    });

    it('ne compte jamais les appels d’un autre locataire', async () => {
      await creerAppel(microfinance);
      await creerAppel(microfinance);

      const reponse = await lire(await jeton('auditeur@a.cm')).expect(200);
      expect(reponse.body.totaux.appelsConserves).toBe(0);
      expect(reponse.body.volumeParJour.every((j: { appels: number }) => j.appels === 0)).toBe(
        true,
      );
    });

    it('ne laisse pas voir les quarantaines d’un autre locataire', async () => {
      await prisma.auditEvent.create({
        data: { tenantId: microfinance, action: 'QUARANTINE', detail: { motif: 'chez-le-voisin' } },
      });

      const reponse = await lire(await jeton('auditeur@a.cm')).expect(200);
      expect(JSON.stringify(reponse.body.quarantaines)).not.toMatch(/chez-le-voisin/);
    });
  });
});
