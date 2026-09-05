import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import request from 'supertest';
import type { PurgeReportSummary } from '@voxecho/shared';
import { hashPassword } from '../src/auth/password';
import { canonique } from '../src/purge/certificat.service';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026-portail';
const MOTIF = 'Échéance de conservation atteinte, validée par la conformité';

/**
 * Certificat de destruction — CLAUDE.md §9.31.
 *
 * C'est la pièce que la banque conserve quand les enregistrements, eux,
 * n'existent plus. Ce que ces cas vérifient : il dit ce qui a été détruit, au
 * nom de quelle durée et sur l'ordre de qui ; son empreinte ne dépend pas du
 * format ; et il n'existe pas pour une destruction qui n'a pas eu lieu.
 */
describe('certificat de destruction', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let banque: string;
  const storageDir = process.env.STORAGE_DIR as string;

  async function jeton(email = 'admin@a.cm'): Promise<string> {
    const reponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: MOT_DE_PASSE })
      .expect(200);
    return (reponse.body as { accessToken: string }).accessToken;
  }

  /** Un appel échu, avec son fichier réellement présent sur le disque. */
  async function appelEchu(refci: string, categorie: string): Promise<string> {
    const debut = new Date();
    debut.setUTCFullYear(debut.getUTCFullYear() - 5);
    const chemin = `${banque}/2021/09/${refci}.wav`;
    await mkdir(join(storageDir, banque, '2021', '09'), { recursive: true });
    await writeFile(join(storageDir, chemin), 'audio');

    return (
      await prisma.recording.create({
        data: {
          tenantId: banque,
          refci,
          near: '1001',
          far: '699112233',
          direction: 'outbound',
          startedAt: debut,
          durationSec: 60,
          filePath: chemin,
          sha256: refci.padEnd(64, '0'),
          sizeBytes: BigInt(960_000),
          source: 'simulator',
          operationCategory: categorie,
        },
      })
    ).id;
  }

  async function purger(): Promise<{ rapport: PurgeReportSummary; admin: string }> {
    const admin = await jeton();
    const rapport = (
      await request(app.getHttpServer())
        .post('/api/purge/reports')
        .set('Authorization', `Bearer ${admin}`)
        .expect(201)
    ).body as PurgeReportSummary;

    await request(app.getHttpServer())
      .post(`/api/purge/reports/${rapport.id}/execute`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ reason: MOTIF })
      .expect(200);

    return { rapport, admin };
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
    banque = (
      await prisma.tenant.create({ data: { name: 'Banque de la CEMAC', slug: 'banque-a' } })
    ).id;
    for (const [email, role] of [
      ['admin@a.cm', 'ADMIN'],
      ['auditeur@a.cm', 'AUDITOR'],
    ] as const) {
      await prisma.user.create({
        data: { tenantId: banque, email, passwordHash: await hashPassword(MOT_DE_PASSE), role },
      });
    }
    await appelEchu('16778001', 'confirmation_cheque');
    await appelEchu('16778002', 'autre');
  });

  it('n’existe pas pour une destruction qui n’a pas eu lieu', async () => {
    const admin = await jeton();
    const rapport = (
      await request(app.getHttpServer())
        .post('/api/purge/reports')
        .set('Authorization', `Bearer ${admin}`)
        .expect(201)
    ).body as PurgeReportSummary;

    // Un rapport simulé n'a rien détruit : délivrer un certificat serait un faux.
    const refus = await request(app.getHttpServer())
      .get(`/api/purge/reports/${rapport.id}/certificat`)
      .set('Authorization', `Bearer ${admin}`)
      .expect(404);
    expect((refus.body as { message: string }).message).toMatch(/pas de destruction à certifier/);
  });

  it('rend un PDF portant ce qui a été détruit et sur l’ordre de qui', async () => {
    const { rapport, admin } = await purger();

    const reponse = await request(app.getHttpServer())
      .get(`/api/purge/reports/${rapport.id}/certificat`)
      .set('Authorization', `Bearer ${admin}`)
      .responseType('blob')
      .expect(200);

    expect(reponse.headers['content-type']).toBe('application/pdf');
    expect(reponse.headers['content-disposition']).toContain(
      `certificat-destruction-${rapport.id}.pdf`,
    );
    expect(reponse.headers['x-certificat-sha256']).toMatch(/^[0-9a-f]{64}$/);
    const pdf = Buffer.from(reponse.body as Buffer);
    expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(pdf.byteLength).toBeGreaterThan(1000);
  });

  it('rend un CSV lisible par un tableur français, avec les durées appliquées', async () => {
    const { rapport, admin } = await purger();

    const reponse = await request(app.getHttpServer())
      .get(`/api/purge/reports/${rapport.id}/certificat`)
      .query({ format: 'csv' })
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);

    const csv = reponse.text;
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toMatch(/# Exécuté par;admin@a\.cm/);
    expect(csv).toMatch(/# Motif;Échéance de conservation atteinte/);
    // Chaque ligne dit au nom de quelle durée la pièce a été détruite.
    expect(csv).toMatch(/identifiant;refci;debute_le;categorie;conservation_jours/);
    expect(csv).toMatch(/16778001;.*;confirmation_cheque;730/);
    expect(csv).toMatch(/16778002;.*;autre;730/);
  });

  it('donne la même empreinte pour les deux formats, et l’inscrit au journal', async () => {
    const { rapport, admin } = await purger();

    const pdf = await request(app.getHttpServer())
      .get(`/api/purge/reports/${rapport.id}/certificat`)
      .set('Authorization', `Bearer ${admin}`)
      .responseType('blob')
      .expect(200);
    const csv = await request(app.getHttpServer())
      .get(`/api/purge/reports/${rapport.id}/certificat`)
      .query({ format: 'csv' })
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);

    // L'empreinte porte sur le contenu, non sur le fichier : c'est elle qui
    // identifie ce qui a été détruit, quelle que soit la forme présentée.
    expect(csv.headers['x-certificat-sha256']).toBe(pdf.headers['x-certificat-sha256']);

    // Et c'est celle qui a été figée à l'instant de la destruction.
    const run = await prisma.purgeRun.findUniqueOrThrow({ where: { id: rapport.id } });
    expect(run.certificateSha256).toBe(pdf.headers['x-certificat-sha256']);

    const traces = await prisma.auditEvent.findMany({
      where: { action: 'EXPORT', detail: { path: ['objet'], equals: 'certificat-purge' } },
      orderBy: { at: 'asc' },
    });
    expect(traces).toHaveLength(2);
    expect(traces[0]?.detail).toMatchObject({
      rapportId: rapport.id,
      format: 'pdf',
      sha256Certificat: run.certificateSha256,
      detruits: 2,
    });
    expect(traces[1]?.detail).toMatchObject({ format: 'csv' });
  });

  it('reste vérifiable : la même donnée donne toujours la même empreinte', () => {
    // Deux constructions du même certificat, champs dans un ordre différent,
    // doivent se sérialiser à l'identique — sans quoi la vérification ne
    // prouverait rien.
    const gauche = canonique({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } });
    const droite = canonique({ a: { c: [3, { e: 5, f: 4 }], d: 2 }, b: 1 });
    expect(gauche).toBe(droite);
  });

  it('porte les conservations forcées épargnées, avec leur motif', async () => {
    const admin = await jeton();
    const protege = await prisma.recording.findFirstOrThrow({ where: { refci: '16778001' } });
    await request(app.getHttpServer())
      .post(`/api/recordings/${protege.id}/holds`)
      .set('Authorization', `Bearer ${admin}`)
      .send({
        reason: 'Réquisition judiciaire, pièce à conserver jusqu’au jugement.',
        caseReference: 'REQ-2026-118',
      })
      .expect(201);

    const { rapport } = await purger();
    const csv = await request(app.getHttpServer())
      .get(`/api/purge/reports/${rapport.id}/certificat`)
      .query({ format: 'csv' })
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);

    // Un auditeur veut voir ce qui a échappé à la purge et pourquoi (§9.7).
    expect(csv.text).toMatch(/# Épargnés par conservation forcée;1/);
    expect(csv.text).toMatch(/# Détruits;1/);
    expect(csv.text).not.toMatch(/16778001;/);
  });

  it('s’ouvre à l’auditeur : c’est une pièce de conformité, pas un acte', async () => {
    const { rapport } = await purger();
    await request(app.getHttpServer())
      .get(`/api/purge/reports/${rapport.id}/certificat`)
      .set('Authorization', `Bearer ${await jeton('auditeur@a.cm')}`)
      .responseType('blob')
      .expect(200);
  });
});
