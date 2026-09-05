import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { RETENTION_DAYS_DEFAULT } from '@voxecho/shared';
import { hashPassword } from '../src/auth/password';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026';
/** Plancher de l'instance de test — le défaut, 730 jours. */
const PLANCHER = 730;

/**
 * Rétention et conservation forcée — CLAUDE.md §5 et §9.6.
 *
 * Deux mécanismes opposés se rencontrent ici : la rétention détruit au bout
 * d'un délai, le hold empêche de détruire. Ce que ces tests protègent, c'est
 * qu'aucun des deux ne puisse s'exercer sans laisser au journal de quoi
 * répondre à « qui a décidé cela, quand, et pourquoi ».
 */
describe('rétention et conservation forcée', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let passwordHash: string;
  let banque: string;
  let microfinance: string;
  let appelId: string;

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

    appelId = (await creerEnregistrement(banque)).id;
  });

  let compteur = 0;
  async function creerEnregistrement(tenantId: string) {
    compteur += 1;
    return prisma.recording.create({
      data: {
        tenantId,
        refci: `1000000${compteur}`,
        near: '1001',
        far: '699112233',
        direction: 'outbound',
        startedAt: new Date('2026-09-01T14:30:12+01:00'),
        durationSec: 183,
        filePath: `${tenantId}/2026/09/appel-${compteur}.wav`,
        sha256: `sha-${compteur}`.padEnd(64, '0'),
        sizeBytes: BigInt(2_928_044),
        source: 'simulator',
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

  const avec = (token: string) => ({
    get: (url: string) =>
      request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`),
    put: (url: string) =>
      request(app.getHttpServer()).put(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) =>
      request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${token}`),
  });

  const traces = (action: string) =>
    prisma.auditEvent.findMany({ where: { action: action as never }, orderBy: { at: 'desc' } });

  describe('politique de conservation', () => {
    it('rend le défaut du produit pour un locataire qui n’a jamais rien réglé', async () => {
      const reponse = await avec(await jeton('auditeur@a.cm'))
        .get('/api/retention')
        .expect(200);
      expect(reponse.body).toMatchObject({
        days: RETENTION_DAYS_DEFAULT,
        appliesTo: 'all',
        belowFloorReason: null,
        minDays: PLANCHER,
      });
    });

    it.each(['admin@a.cm', 'superviseur@a.cm', 'auditeur@a.cm'])(
      'se lit par %s : un auditeur doit pouvoir dire combien de temps on garde',
      async (email) => {
        await avec(await jeton(email))
          .get('/api/retention')
          .expect(200);
      },
    );

    it('s’allonge sans justification, et la trace dit d’où l’on vient', async () => {
      const reponse = await avec(await jeton('admin@a.cm'))
        .put('/api/retention')
        .send({ days: 1095 })
        .expect(200);
      expect(reponse.body).toMatchObject({ days: 1095, belowFloorReason: null });

      const [trace] = await traces('RETENTION_SET');
      expect(trace?.detail).toMatchObject({
        avantJours: RETENTION_DAYS_DEFAULT,
        apresJours: 1095,
        plancherJours: PLANCHER,
        sousLePlancher: false,
        raccourcie: false,
      });
    });

    it.each([
      ['SUPERVISOR', 'superviseur@a.cm'],
      ['AUDITOR', 'auditeur@a.cm'],
    ])('refuse que %s programme la destruction de preuves', async (_role, email) => {
      await avec(await jeton(email))
        .put('/api/retention')
        .send({ days: 1095 })
        .expect(403);
      expect(await traces('RETENTION_SET')).toHaveLength(0);
    });

    describe('sous le plancher de l’instance', () => {
      it('refuse une conservation plus courte sans motif écrit', async () => {
        const reponse = await avec(await jeton('admin@a.cm'))
          .put('/api/retention')
          .send({ days: 90 })
          .expect(400);
        expect(JSON.stringify(reponse.body)).toMatch(/plancher/);
        expect(await traces('RETENTION_SET')).toHaveLength(0);
      });

      it('refuse une initiale en guise de motif', async () => {
        await avec(await jeton('admin@a.cm'))
          .put('/api/retention')
          .send({ days: 90, belowFloorReason: 'ok' })
          .expect(400);
      });

      it('accepte la dérogation motivée, et la porte sur la politique en vigueur', async () => {
        const motif = 'Filiale cédée : conservation reprise par l’acquéreur, acte du 12/08/2026.';
        const reponse = await avec(await jeton('admin@a.cm'))
          .put('/api/retention')
          .send({ days: 90, belowFloorReason: motif })
          .expect(200);

        expect(reponse.body).toMatchObject({ days: 90, belowFloorReason: motif });

        // La colonne dit que la politique **en vigueur** déroge — c'est ce
        // qu'un contrôleur lit d'abord, avant de remonter le journal.
        const enBase = await prisma.retentionPolicy.findFirstOrThrow({
          where: { tenantId: banque },
        });
        expect(enBase.belowFloorReason).toBe(motif);

        const [trace] = await traces('RETENTION_SET');
        expect(trace?.detail).toMatchObject({
          avantJours: RETENTION_DAYS_DEFAULT,
          apresJours: 90,
          sousLePlancher: true,
          motifDerogation: motif,
          raccourcie: true,
        });
      });

      it('efface la mention de dérogation quand on repasse au-dessus', async () => {
        const admin = await jeton('admin@a.cm');
        await avec(admin)
          .put('/api/retention')
          .send({ days: 90, belowFloorReason: 'Dérogation temporaire, décision du comité.' })
          .expect(200);

        const reponse = await avec(admin).put('/api/retention').send({ days: 1095 }).expect(200);
        expect(reponse.body.belowFloorReason).toBeNull();
      });
    });

    it('refuse un motif de dérogation là où il n’y a rien à déroger', async () => {
      // Sinon une politique parfaitement régulière s'afficherait comme
      // dérogatoire à un contrôleur qui la lit.
      await avec(await jeton('admin@a.cm'))
        .put('/api/retention')
        .send({ days: 1095, belowFloorReason: 'Motif sans objet mais bien assez long.' })
        .expect(400);
    });

    it.each([
      ['zéro jour', 0],
      ['durée négative', -30],
      ['au-delà de vingt ans', 7301],
    ])('refuse : %s', async (_libelle, days) => {
      await avec(await jeton('admin@a.cm'))
        .put('/api/retention')
        .send({ days })
        .expect(400);
    });

    it('ne franchit pas le cloisonnement', async () => {
      await avec(await jeton('admin@a.cm'))
        .put('/api/retention')
        .send({ days: 1095 })
        .expect(200);

      const chezVoisin = await avec(await jeton('admin@b.cm'))
        .get('/api/retention')
        .expect(200);
      expect(chezVoisin.body.days).toBe(RETENTION_DAYS_DEFAULT);
    });
  });

  describe('conservation forcée', () => {
    const MOTIF = 'Contentieux 2026-114 : pièce réclamée par le contrôle COBAC.';

    it('se pose avec son motif, et s’inscrit au journal', async () => {
      const reponse = await avec(await jeton('superviseur@a.cm'))
        .post(`/api/recordings/${appelId}/holds`)
        .send({ reason: MOTIF, caseReference: 'REQ-2026-118' })
        .expect(201);

      expect(reponse.body).toMatchObject({
        recordingId: appelId,
        reason: MOTIF,
        setByEmail: 'superviseur@a.cm',
        releasedAt: null,
      });

      const [trace] = await traces('HOLD_SET');
      expect(trace?.recordingId).toBe(appelId);
      expect(trace?.detail).toMatchObject({ motif: MOTIF });
    });

    it('marque l’appel dans la liste, sans recopier le hold dans son statut', async () => {
      const auditeur = await jeton('auditeur@a.cm');
      const avant = await avec(auditeur).get('/api/recordings').expect(200);
      expect(avant.body.items[0].underHold).toBe(false);

      await avec(await jeton('admin@a.cm'))
        .post(`/api/recordings/${appelId}/holds`)
        .send({ reason: MOTIF, caseReference: 'REQ-2026-118' })
        .expect(201);

      const apres = await avec(auditeur).get('/api/recordings').expect(200);
      expect(apres.body.items[0].underHold).toBe(true);
      // Le statut reste celui du fichier : une seule source de vérité (§9.6).
      expect(apres.body.items[0].status).toBe('stored');
      expect((await prisma.recording.findFirstOrThrow({ where: { id: appelId } })).status).toBe(
        'stored',
      );
    });

    it('refuse d’empiler deux conservations sur le même appel', async () => {
      const admin = await jeton('admin@a.cm');
      await avec(admin)
        .post(`/api/recordings/${appelId}/holds`)
        .send({ reason: MOTIF, caseReference: 'REQ-2026-118' })
        .expect(201);
      await avec(admin)
        .post(`/api/recordings/${appelId}/holds`)
        .send({ reason: MOTIF, caseReference: 'REQ-2026-118' })
        .expect(409);
      expect(await traces('HOLD_SET')).toHaveLength(1);
    });

    it('se lève avec son propre motif, en rappelant ce qu’on levait', async () => {
      const admin = await jeton('admin@a.cm');
      await avec(admin)
        .post(`/api/recordings/${appelId}/holds`)
        .send({ reason: MOTIF, caseReference: 'REQ-2026-118' })
        .expect(201);

      const leve = 'Contentieux clos : jugement rendu le 30/08/2026.';
      // Ce locataire n'a qu'un administrateur : la levée par celui qui a posé
      // reste possible, mais doit être assumée et sera consignée (§9.29).
      const reponse = await avec(admin)
        .post(`/api/recordings/${appelId}/holds/release`)
        .send({ reason: leve, acceptSansContreValidation: true })
        .expect(201);

      expect(reponse.body).toMatchObject({
        releasedByEmail: 'admin@a.cm',
        releaseReason: leve,
      });
      expect(reponse.body.releasedAt).not.toBeNull();

      const [trace] = await traces('HOLD_RELEASE');
      expect(trace?.detail).toMatchObject({ motif: leve, motifPose: MOTIF });

      const apres = await avec(admin).get('/api/recordings').expect(200);
      expect(apres.body.items[0].underHold).toBe(false);
    });

    it('refuse de lever ce qui n’est pas posé', async () => {
      await avec(await jeton('admin@a.cm'))
        .post(`/api/recordings/${appelId}/holds/release`)
        .send({ reason: 'Levée sans objet mais bien assez longue.' })
        .expect(404);
    });

    it.each([
      ['pose', `holds`],
      ['levée', `holds/release`],
    ])('exige un motif lisible à la %s', async (_libelle, chemin) => {
      await avec(await jeton('admin@a.cm'))
        .post(`/api/recordings/${appelId}/${chemin}`)
        .send({ reason: 'court' })
        .expect(400);
    });

    it('refuse qu’un AUDITOR pose ou lève une conservation', async () => {
      const auditeur = await jeton('auditeur@a.cm');
      await avec(auditeur)
        .post(`/api/recordings/${appelId}/holds`)
        .send({ reason: MOTIF, caseReference: 'REQ-2026-118' })
        .expect(403);
      await avec(auditeur)
        .post(`/api/recordings/${appelId}/holds/release`)
        .send({ reason: MOTIF, acceptSansContreValidation: true })
        .expect(403);
      expect(await traces('HOLD_SET')).toHaveLength(0);
    });

    it('laisse l’AUDITOR consulter l’historique : il constate, il n’ordonne pas', async () => {
      const admin = await jeton('admin@a.cm');
      await avec(admin)
        .post(`/api/recordings/${appelId}/holds`)
        .send({ reason: MOTIF, caseReference: 'REQ-2026-118' })
        .expect(201);
      await avec(admin)
        .post(`/api/recordings/${appelId}/holds/release`)
        .send({ reason: 'Contentieux clos, pièce libérée.', acceptSansContreValidation: true })
        .expect(201);
      await avec(admin)
        .post(`/api/recordings/${appelId}/holds`)
        .send({ reason: MOTIF, caseReference: 'REQ-2026-118' })
        .expect(201);

      const reponse = await avec(await jeton('auditeur@a.cm'))
        .get(`/api/recordings/${appelId}/holds`)
        .expect(200);

      expect(reponse.body).toHaveLength(2);
      // Le plus récent en tête, et c'est lui qui est actif.
      expect(reponse.body[0].releasedAt).toBeNull();
      expect(reponse.body[1].releasedAt).not.toBeNull();
      expect(reponse.body[1].releasedByEmail).toBe('admin@a.cm');
    });

    it('ne pose rien sur l’appel d’un autre locataire, et ne dit pas qu’il existe', async () => {
      await avec(await jeton('admin@b.cm'))
        .post(`/api/recordings/${appelId}/holds`)
        .send({ reason: MOTIF, caseReference: 'REQ-2026-118' })
        .expect(404);
      expect(await traces('HOLD_SET')).toHaveLength(0);
    });

    it('ne compte comme sous conservation que les appels du locataire qui demande', async () => {
      const chezVoisin = (await creerEnregistrement(microfinance)).id;
      await avec(await jeton('admin@b.cm'))
        .post(`/api/recordings/${chezVoisin}/holds`)
        .send({ reason: MOTIF, caseReference: 'REQ-2026-118' })
        .expect(201);

      const liste = await avec(await jeton('auditeur@a.cm'))
        .get('/api/recordings')
        .expect(200);
      expect(liste.body.total).toBe(1);
      expect(liste.body.items[0].underHold).toBe(false);
    });
  });
});
