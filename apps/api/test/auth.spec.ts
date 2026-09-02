import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { hashPassword } from '../src/auth/password';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026';

describe('authentification', () => {
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
    await prisma.user.create({
      data: { tenantId: banque, email: 'auditeur@a.cm', passwordHash, role: 'AUDITOR' },
    });
    await prisma.user.create({
      data: { tenantId: microfinance, email: 'admin@b.cm', passwordHash, role: 'ADMIN' },
    });
  });

  const connexion = (email: string, password = MOT_DE_PASSE) =>
    request(app.getHttpServer()).post('/api/auth/login').send({ email, password });

  it('délivre une paire de jetons pour des identifiants valides', async () => {
    const response = await connexion('auditeur@a.cm').expect(200);
    expect(typeof response.body.accessToken).toBe('string');
    expect(typeof response.body.refreshToken).toBe('string');
    expect(response.body.expiresIn).toBe('15m');
  });

  it('ne renvoie jamais le hachage du mot de passe', async () => {
    const response = await connexion('auditeur@a.cm').expect(200);
    expect(JSON.stringify(response.body)).not.toContain('argon2');
  });

  it('trace la connexion réussie au journal d’audit', async () => {
    await connexion('auditeur@a.cm').expect(200);
    const events = await prisma.auditEvent.findMany({ where: { action: 'LOGIN' } });
    expect(events).toHaveLength(1);
    expect(events[0]?.tenantId).toBe(banque);
    expect(events[0]?.detail).toMatchObject({ resultat: 'succes', role: 'AUDITOR' });
  });

  it('accepte une adresse saisie avec des majuscules ou des espaces', async () => {
    await connexion('  Auditeur@A.cm  ').expect(200);
  });

  it('refuse un mot de passe erroné sans dire pourquoi', async () => {
    const response = await connexion('auditeur@a.cm', 'MauvaisMotDePasse').expect(401);
    expect(response.body.message).toBe('Identifiants invalides.');
  });

  it('répond la même chose pour une adresse inconnue', async () => {
    const response = await connexion('inconnu@a.cm').expect(401);
    expect(response.body.message).toBe('Identifiants invalides.');
  });

  it('refuse une adresse mal formée avant toute vérification', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'pas-une-adresse', password: MOT_DE_PASSE })
      .expect(400);
  });

  it('refuse un compte désactivé', async () => {
    await prisma.user.update({ where: { email: 'auditeur@a.cm' }, data: { active: false } });
    const response = await connexion('auditeur@a.cm').expect(403);
    expect(response.body.message).toBe('Compte désactivé.');
  });

  it('verrouille le compte après cinq échecs, puis refuse même le bon mot de passe', async () => {
    for (let i = 0; i < 5; i += 1) {
      await connexion('auditeur@a.cm', 'MauvaisMotDePasse').expect(401);
    }

    const apres = await prisma.user.findUniqueOrThrow({ where: { email: 'auditeur@a.cm' } });
    expect(apres.lockedUntil).not.toBeNull();

    const response = await connexion('auditeur@a.cm').expect(403);
    expect(response.body.message).toMatch(/verrouillé/);
  });

  it('remet le compteur d’échecs à zéro après une connexion réussie', async () => {
    await connexion('auditeur@a.cm', 'MauvaisMotDePasse').expect(401);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { email: 'auditeur@a.cm' } }))
        .failedLoginAttempts,
    ).toBe(1);

    await connexion('auditeur@a.cm').expect(200);
    const apres = await prisma.user.findUniqueOrThrow({ where: { email: 'auditeur@a.cm' } });
    expect(apres.failedLoginAttempts).toBe(0);
    expect(apres.lastLoginAt).not.toBeNull();
  });
});
