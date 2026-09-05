// En tête, avant tout ce qui charge la configuration : voir le module lui-même.
import './helpers/plancher-reglementaire';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { RetentionPolicySetResponse } from '@voxecho/shared';
import { hashPassword } from '../src/auth/password';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026-portail';

/**
 * Plancher réglementaire appliqué — CLAUDE.md §9.30.
 *
 * L'instance déclare ici 3650 jours pour les confirmations de chèque et 1825
 * pour les ordres de change. Ce que ces cas vérifient : le refus est absolu,
 * il ne se déroge pas, et il se distingue du plancher de maison.
 */
describe('plancher réglementaire', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let banque: string;

  async function jeton(): Promise<string> {
    const reponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'admin@a.cm', password: MOT_DE_PASSE })
      .expect(200);
    return (reponse.body as { accessToken: string }).accessToken;
  }

  function definir(corps: Record<string, unknown>, jetonAcces: string) {
    return request(app.getHttpServer())
      .put('/api/retention')
      .set('Authorization', `Bearer ${jetonAcces}`)
      .send(corps);
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
    await prisma.user.create({
      data: {
        tenantId: banque,
        email: 'admin@a.cm',
        passwordHash: await hashPassword(MOT_DE_PASSE),
        role: 'ADMIN',
      },
    });
  });

  it('refuse une durée inférieure au minimum réglementaire, motif ou non', async () => {
    const admin = await jeton();

    const refus = await definir({ days: 1000, appliesTo: 'confirmation_cheque' }, admin).expect(
      400,
    );
    expect((refus.body as { message: string }).message).toBe(
      'Durée refusée : en dessous du minimum réglementaire de 3650 jours.',
    );

    // Le motif écrit ouvre le plancher de maison, jamais le réglementaire : on
    // ne déroge pas à une obligation extérieure par une phrase de formulaire.
    await definir(
      {
        days: 1000,
        appliesTo: 'confirmation_cheque',
        belowFloorReason: 'Décision du comité de conformité du 5 septembre',
      },
      admin,
    ).expect(400);
  });

  it('accepte à partir du minimum, et laisse le plancher de maison jouer ailleurs', async () => {
    const admin = await jeton();
    await definir({ days: 3650, appliesTo: 'confirmation_cheque' }, admin).expect(200);

    // « autre » n'a pas de plancher réglementaire : c'est celui de l'instance
    // qui s'applique, avec sa dérogation motivée (§9.6).
    await definir({ days: 90, appliesTo: 'autre' }, admin).expect(400);
    await definir(
      { days: 90, appliesTo: 'autre', belowFloorReason: 'Appels internes sans enjeu bancaire' },
      admin,
    ).expect(200);
  });

  it('annonce le plancher de chaque périmètre avant toute saisie', async () => {
    const ensemble = (
      await request(app.getHttpServer())
        .get('/api/retention/ensemble')
        .set('Authorization', `Bearer ${await jeton()}`)
        .expect(200)
    ).body as RetentionPolicySetResponse;

    // L'écran doit pouvoir dire le minimum avant que l'utilisateur ne se
    // heurte au refus.
    const parCategorie = Object.fromEntries(
      ensemble.parCategorie.map((entree) => [entree.appliesTo, entree.plancherReglementaire]),
    );
    expect(parCategorie).toEqual({
      confirmation_cheque: 3650,
      operation_change: 1825,
      autre: 0,
    });
    expect(ensemble.generale.plancherReglementaire).toBe(0);
  });

  it('distingue une durée décidée d’une durée héritée', async () => {
    const admin = await jeton();
    await definir({ days: 3650, appliesTo: 'confirmation_cheque' }, admin).expect(200);

    const ensemble = (
      await request(app.getHttpServer())
        .get('/api/retention/ensemble')
        .set('Authorization', `Bearer ${admin}`)
        .expect(200)
    ).body as RetentionPolicySetResponse;

    const cheque = ensemble.parCategorie.find((e) => e.appliesTo === 'confirmation_cheque');
    const autre = ensemble.parCategorie.find((e) => e.appliesTo === 'autre');
    expect(cheque).toMatchObject({ days: 3650, enregistree: true });
    // Sans cette distinction, on ne saurait pas si 730 jours résultent d'un
    // choix ou d'un défaut.
    expect(autre).toMatchObject({ days: 730, enregistree: false });
  });
});
