import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { Page, RecordingListItem } from '@voxecho/shared';
import { hashPassword } from '../src/auth/password';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026';

/**
 * Recherche — CLAUDE.md §6 : « par numéro (near/far), plage de dates,
 * direction, durée min/max ». Les critères se cumulent, et aucun d'eux ne
 * peut élargir le périmètre au-delà du locataire du jeton.
 */
describe('recherche d’enregistrements', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let banque: string;
  let microfinance: string;
  let token: string;

  interface Appel {
    tenantId: string;
    near: string;
    far: string;
    direction: 'outbound' | 'inbound' | 'internal';
    /** Horodatage local de Douala, écrit avec son décalage. */
    startedAt: string;
    durationSec: number;
    refci: string;
  }

  const enregistrement = (appel: Appel) => ({
    tenantId: appel.tenantId,
    refci: appel.refci,
    near: appel.near,
    far: appel.far,
    direction: appel.direction,
    startedAt: new Date(appel.startedAt),
    durationSec: appel.durationSec,
    filePath: `${appel.tenantId}/2026/09/${appel.refci}.wav`,
    sha256: appel.refci.padEnd(64, '0'),
    sizeBytes: BigInt(1_000_000),
    source: 'simulator' as const,
  });

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
    microfinance = (await prisma.tenant.create({ data: { name: 'MFI B', slug: 'mfi-b' } })).id;
    await prisma.user.create({
      data: {
        tenantId: banque,
        email: 'auditeur@a.cm',
        passwordHash: await hashPassword(MOT_DE_PASSE),
        role: 'AUDITOR',
      },
    });

    await prisma.recording.createMany({
      data: [
        // Guichet, sortant, court, le 1er septembre en matinée.
        enregistrement({
          tenantId: banque,
          refci: '10000001',
          near: '1001',
          far: '699112233',
          direction: 'outbound',
          startedAt: '2026-09-01T09:15:00+01:00',
          durationSec: 45,
        }),
        // Même correspondant, entrant, long, le 2 septembre.
        enregistrement({
          tenantId: banque,
          refci: '10000002',
          near: '1002',
          far: '699112233',
          direction: 'inbound',
          startedAt: '2026-09-02T14:30:00+01:00',
          durationSec: 600,
        }),
        // Interne, durée moyenne, le 3 septembre.
        enregistrement({
          tenantId: banque,
          refci: '10000003',
          near: '1003',
          far: '2001',
          direction: 'internal',
          startedAt: '2026-09-03T11:00:00+01:00',
          durationSec: 180,
        }),
        // Le 1er septembre à 23 h 30 heure de Douala : le même jour local,
        // mais déjà 22 h 30 en UTC.
        enregistrement({
          tenantId: banque,
          refci: '10000004',
          near: '1010',
          far: '677889900',
          direction: 'outbound',
          startedAt: '2026-09-01T23:30:00+01:00',
          durationSec: 90,
        }),
        // Le 2 septembre à 00 h 30 heure de Douala : encore le 1er en UTC.
        enregistrement({
          tenantId: banque,
          refci: '10000005',
          near: '1010',
          far: '677889900',
          direction: 'outbound',
          startedAt: '2026-09-02T00:30:00+01:00',
          durationSec: 30,
        }),
        // Chez l'autre locataire, avec le même numéro : ne doit jamais sortir.
        enregistrement({
          tenantId: microfinance,
          refci: '20000001',
          near: '1001',
          far: '699112233',
          direction: 'outbound',
          startedAt: '2026-09-01T09:15:00+01:00',
          durationSec: 45,
        }),
      ],
    });

    const reponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'auditeur@a.cm', password: MOT_DE_PASSE })
      .expect(200);
    token = (reponse.body as { accessToken: string }).accessToken;
  });

  const chercher = (query = '') =>
    request(app.getHttpServer())
      .get(`/api/recordings${query}`)
      .set('Authorization', `Bearer ${token}`);

  const refcis = (body: Page<RecordingListItem>): string[] =>
    body.items.map((item) => item.refci).sort();

  it('sans filtre, rend les cinq appels du locataire et aucun autre', async () => {
    const reponse = await chercher().expect(200);
    expect(reponse.body.total).toBe(5);
    expect(refcis(reponse.body)).not.toContain('20000001');
  });

  describe('par numéro', () => {
    it('trouve un numéro porté par le correspondant', async () => {
      const reponse = await chercher('?phone=699112233').expect(200);
      expect(refcis(reponse.body)).toEqual(['10000001', '10000002']);
    });

    it('trouve un numéro porté par le poste enregistré', async () => {
      const reponse = await chercher('?phone=1010').expect(200);
      expect(refcis(reponse.body)).toEqual(['10000004', '10000005']);
    });

    it('accepte une correspondance partielle : le préfixe d’un opérateur', async () => {
      const reponse = await chercher('?phone=6771').expect(200);
      expect(reponse.body.total).toBe(0);

      const prefixe = await chercher('?phone=677').expect(200);
      expect(refcis(prefixe.body)).toEqual(['10000004', '10000005']);
    });

    it('ne franchit pas le cloisonnement, même sur un numéro partagé', async () => {
      // « 1001 » et « 699112233 » existent aussi chez l'autre locataire.
      const reponse = await chercher('?phone=1001').expect(200);
      expect(reponse.body.total).toBe(1);
      expect(refcis(reponse.body)).toEqual(['10000001']);
    });
  });

  describe('par plage de dates', () => {
    it('retient les deux bornes, jour entier compris', async () => {
      const reponse = await chercher('?from=2026-09-01&to=2026-09-01').expect(200);
      // L'appel de 23 h 30 est du 1er à Douala : il doit sortir.
      expect(refcis(reponse.body)).toEqual(['10000001', '10000004']);
    });

    it('classe un appel selon l’heure de Douala, pas selon UTC', async () => {
      // 00 h 30 le 2 septembre à Douala, c'est encore le 1er en UTC : il ne
      // doit pas remonter dans une recherche sur le 1er.
      const premier = await chercher('?from=2026-09-01&to=2026-09-01').expect(200);
      expect(refcis(premier.body)).not.toContain('10000005');

      const second = await chercher('?from=2026-09-02&to=2026-09-02').expect(200);
      expect(refcis(second.body)).toEqual(['10000002', '10000005']);
    });

    it('accepte une borne seule', async () => {
      const depuis = await chercher('?from=2026-09-03').expect(200);
      expect(refcis(depuis.body)).toEqual(['10000003']);

      const jusqua = await chercher('?to=2026-09-01').expect(200);
      expect(refcis(jusqua.body)).toEqual(['10000001', '10000004']);
    });
  });

  it('filtre par sens d’appel', async () => {
    const entrants = await chercher('?direction=inbound').expect(200);
    expect(refcis(entrants.body)).toEqual(['10000002']);

    const internes = await chercher('?direction=internal').expect(200);
    expect(refcis(internes.body)).toEqual(['10000003']);
  });

  describe('par durée', () => {
    it('applique une borne basse, une borne haute, ou les deux', async () => {
      const longs = await chercher('?minDurationSec=180').expect(200);
      expect(refcis(longs.body)).toEqual(['10000002', '10000003']);

      const courts = await chercher('?maxDurationSec=60').expect(200);
      expect(refcis(courts.body)).toEqual(['10000001', '10000005']);

      const moyens = await chercher('?minDurationSec=45&maxDurationSec=180').expect(200);
      expect(refcis(moyens.body)).toEqual(['10000001', '10000003', '10000004']);
    });

    it('retient les bornes elles-mêmes', async () => {
      const reponse = await chercher('?minDurationSec=45&maxDurationSec=45').expect(200);
      expect(refcis(reponse.body)).toEqual(['10000001']);
    });
  });

  it('cumule les critères plutôt que de les alterner', async () => {
    const reponse = await chercher(
      '?phone=677889900&direction=outbound&from=2026-09-01&to=2026-09-02&maxDurationSec=60',
    ).expect(200);
    expect(refcis(reponse.body)).toEqual(['10000005']);
  });

  it('pagine sur le résultat filtré, pas sur le total du locataire', async () => {
    const reponse = await chercher('?phone=1010&pageSize=1').expect(200);
    expect(reponse.body.total).toBe(2);
    expect(reponse.body.pageCount).toBe(2);
    expect(reponse.body.items).toHaveLength(1);
  });

  describe('critères refusés', () => {
    it.each([
      ['date de début après la date de fin', '?from=2026-09-05&to=2026-09-01'],
      ['durée minimale supérieure à la maximale', '?minDurationSec=600&maxDurationSec=60'],
      ['date mal formée', '?from=01/09/2026'],
      ['sens inconnu', '?direction=sortant'],
      ['numéro à caractères interdits', '?phone=699%20112%20233'],
      ['durée négative', '?minDurationSec=-1'],
      ['filtre inconnu', '?operateur=mtn'],
    ])('refuse : %s', async (_libelle, query) => {
      await chercher(query).expect(400);
    });

    it('ne trace aucune recherche quand les critères sont refusés', async () => {
      await chercher('?from=2026-09-05&to=2026-09-01').expect(400);
      expect(await prisma.auditEvent.count({ where: { action: 'SEARCH' } })).toBe(0);
    });
  });

  it('consigne les critères au journal d’audit', async () => {
    await chercher('?phone=699112233&direction=inbound&minDurationSec=120').expect(200);

    const [evenement] = await prisma.auditEvent.findMany({ where: { action: 'SEARCH' } });
    expect(evenement?.tenantId).toBe(banque);
    expect(evenement?.detail).toMatchObject({
      resultats: 1,
      criteres: { numero: '699112233', sens: 'inbound', dureeMin: 120 },
    });
  });

  it('n’encombre pas le journal de critères vides', async () => {
    await chercher().expect(200);
    const [evenement] = await prisma.auditEvent.findMany({ where: { action: 'SEARCH' } });
    expect(evenement?.detail).not.toHaveProperty('criteres');
  });
});
