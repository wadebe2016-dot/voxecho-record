import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { hashPassword } from '../src/auth/password';
import { TokensService } from '../src/auth/tokens.service';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026';

describe('session : rafraîchissement, rotation, déconnexion', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let passwordHash: string;
  let banque: string;

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
    await prisma.user.create({
      data: { tenantId: banque, email: 'auditeur@a.cm', passwordHash, role: 'AUDITOR' },
    });
  });

  async function seConnecter(): Promise<{ accessToken: string; refreshToken: string }> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'auditeur@a.cm', password: MOT_DE_PASSE })
      .expect(200);
    return response.body;
  }

  it('rend le profil du compte connecté, locataire compris', async () => {
    const { accessToken } = await seConnecter();
    const response = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(response.body).toMatchObject({
      email: 'auditeur@a.cm',
      role: 'AUDITOR',
      tenantId: banque,
      tenantName: 'Banque A',
    });
  });

  it('refuse une route protégée sans jeton', async () => {
    await request(app.getHttpServer()).get('/api/auth/me').expect(401);
  });

  it('refuse un jeton falsifié', async () => {
    const { accessToken } = await seConnecter();
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken.slice(0, -3)}xyz`)
      .expect(401);
  });

  it('refuse un en-tête sans le schéma Bearer', async () => {
    const { accessToken } = await seConnecter();
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', accessToken)
      .expect(401);
  });

  it('stocke le jeton de rafraîchissement haché, jamais en clair', async () => {
    const { refreshToken } = await seConnecter();
    const stocke = await prisma.refreshToken.findMany();
    expect(stocke).toHaveLength(1);
    expect(stocke[0]?.tokenHash).not.toBe(refreshToken);
    expect(stocke[0]?.tokenHash).toBe(TokensService.fingerprint(refreshToken));
  });

  it('échange un jeton de rafraîchissement contre une nouvelle paire', async () => {
    const { refreshToken } = await seConnecter();
    const response = await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken })
      .expect(200);
    expect(response.body.accessToken).toBeDefined();
    expect(response.body.refreshToken).not.toBe(refreshToken);
  });

  it('révoque l’ancien jeton à chaque rotation (rejeu impossible)', async () => {
    const { refreshToken } = await seConnecter();
    await request(app.getHttpServer()).post('/api/auth/refresh').send({ refreshToken }).expect(200);
    await request(app.getHttpServer()).post('/api/auth/refresh').send({ refreshToken }).expect(401);
  });

  it('refuse un jeton de rafraîchissement inventé', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/refresh')
      .send({ refreshToken: 'a'.repeat(40) })
      .expect(401);
  });

  it('ferme la session à la déconnexion', async () => {
    const { accessToken, refreshToken } = await seConnecter();
    await request(app.getHttpServer())
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ refreshToken })
      .expect(204);
    await request(app.getHttpServer()).post('/api/auth/refresh').send({ refreshToken }).expect(401);
  });

  it('refuse de rafraîchir la session d’un compte désactivé', async () => {
    const { refreshToken } = await seConnecter();
    await prisma.user.update({ where: { email: 'auditeur@a.cm' }, data: { active: false } });
    await request(app.getHttpServer()).post('/api/auth/refresh').send({ refreshToken }).expect(401);
  });

  it('révoque les sessions ouvertes au verrouillage du compte', async () => {
    const { refreshToken } = await seConnecter();
    for (let i = 0; i < 5; i += 1) {
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'auditeur@a.cm', password: 'MauvaisMotDePasse' })
        .expect(401);
    }
    await request(app.getHttpServer()).post('/api/auth/refresh').send({ refreshToken }).expect(401);
  });
});
