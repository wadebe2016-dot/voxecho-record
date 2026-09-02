import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { hashPassword } from '../src/auth/password';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026';

describe('liste des enregistrements', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let passwordHash: string;
  let banque: string;
  let microfinance: string;

  const enregistrement = (tenantId: string, index: number, jour: number) => ({
    tenantId,
    refci: `1677800${index}`,
    near: '1001',
    far: '699112233',
    direction: 'outbound' as const,
    startedAt: new Date(Date.UTC(2026, 8, jour, 13, 30, 12)),
    durationSec: 60 + index,
    filePath: `${tenantId}/2026/09/appel-${index}.wav`,
    sha256: String(index).repeat(64).slice(0, 64),
    sizeBytes: BigInt(1_000_000 + index),
    source: 'cucm_bib' as const,
  });

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

  async function jeton(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: MOT_DE_PASSE })
      .expect(200);
    return response.body.accessToken;
  }

  const lister = (token: string, requete = '') =>
    request(app.getHttpServer())
      .get(`/api/recordings${requete}`)
      .set('Authorization', `Bearer ${token}`);

  it('refuse la liste sans authentification', async () => {
    await request(app.getHttpServer()).get('/api/recordings').expect(401);
  });

  it('rend une liste vide et bien formée quand rien n’a été ingéré', async () => {
    const response = await lister(await jeton('auditeur@a.cm')).expect(200);
    expect(response.body).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageSize: 25,
      pageCount: 0,
    });
  });

  it('ne montre que les enregistrements du locataire du jeton', async () => {
    await prisma.recording.create({ data: enregistrement(banque, 1, 1) });
    await prisma.recording.create({ data: enregistrement(banque, 2, 2) });
    await prisma.recording.create({ data: enregistrement(microfinance, 3, 3) });

    const vueBanque = await lister(await jeton('auditeur@a.cm')).expect(200);
    expect(vueBanque.body.total).toBe(2);
    expect(vueBanque.body.items.map((item: { refci: string }) => item.refci)).toEqual([
      '16778002',
      '16778001',
    ]);

    const vueMfi = await lister(await jeton('admin@b.cm')).expect(200);
    expect(vueMfi.body.total).toBe(1);
    expect(vueMfi.body.items[0].refci).toBe('16778003');
  });

  it('expose le SHA-256 et une taille exploitable en JSON', async () => {
    await prisma.recording.create({ data: enregistrement(banque, 1, 1) });
    const response = await lister(await jeton('auditeur@a.cm')).expect(200);
    const item = response.body.items[0];
    expect(item.sha256).toHaveLength(64);
    expect(item.sizeBytes).toBe(1_000_001);
    expect(item.source).toBe('cucm-bib');
    expect(item.status).toBe('stored');
  });

  it('trie par date décroissante par défaut, et croissante sur demande', async () => {
    await prisma.recording.create({ data: enregistrement(banque, 1, 1) });
    await prisma.recording.create({ data: enregistrement(banque, 2, 2) });

    const token = await jeton('auditeur@a.cm');
    const croissant = await lister(token, '?sort=startedAt&order=asc').expect(200);
    expect(croissant.body.items[0].refci).toBe('16778001');
  });

  it('pagine côté serveur', async () => {
    for (let i = 1; i <= 5; i += 1) {
      await prisma.recording.create({ data: enregistrement(banque, i, i) });
    }
    const token = await jeton('auditeur@a.cm');

    const page1 = await lister(token, '?page=1&pageSize=2').expect(200);
    expect(page1.body.items).toHaveLength(2);
    expect(page1.body.total).toBe(5);
    expect(page1.body.pageCount).toBe(3);

    const page3 = await lister(token, '?page=3&pageSize=2').expect(200);
    expect(page3.body.items).toHaveLength(1);
  });

  it('refuse une pagination hors bornes ou un tri inconnu', async () => {
    const token = await jeton('auditeur@a.cm');
    await lister(token, '?pageSize=1000').expect(400);
    await lister(token, '?page=0').expect(400);
    await lister(token, '?sort=sha256').expect(400);
    await lister(token, '?inconnu=1').expect(400);
  });

  it('refuse une requête qui désigne un autre locataire', async () => {
    const token = await jeton('auditeur@a.cm');
    await lister(token, `?tenantId=${microfinance}`).expect(403);
  });

  it('trace chaque consultation au journal d’audit', async () => {
    await lister(await jeton('auditeur@a.cm')).expect(200);
    const events = await prisma.auditEvent.findMany({ where: { action: 'SEARCH' } });
    expect(events).toHaveLength(1);
    expect(events[0]?.tenantId).toBe(banque);
    expect(events[0]?.detail).toMatchObject({ page: 1, pageSize: 25, resultats: 0 });
  });
});
