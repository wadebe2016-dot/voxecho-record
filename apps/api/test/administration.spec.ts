import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { InstanceSettingsResponse } from '@voxecho/shared';
import { hashPassword } from '../src/auth/password';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026';

/**
 * Console d'administration — CLAUDE.md §9.22.
 *
 * Le §9.9 avait laissé la réserve : les trois rôles confondent l'administration
 * de l'instance et l'habilitation métier. Ces cas vérifient la séparation là où
 * elle compte — un ADMIN de locataire ne doit pas hériter de l'instance du seul
 * fait qu'il administre sa banque — et que l'écran ne divulgue aucun secret.
 */
describe('administration de l’instance', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let banque: string;

  async function jeton(email: string): Promise<string> {
    const reponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: MOT_DE_PASSE })
      .expect(200);
    return (reponse.body as { accessToken: string }).accessToken;
  }

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    app = await createTestApp();

    await resetTestData(prisma);
    banque = (await prisma.tenant.create({ data: { name: 'Banque A', slug: 'banque-a' } })).id;
    const passwordHash = await hashPassword(MOT_DE_PASSE);
    for (const [email, role, instanceAdmin] of [
      ['instance@a.cm', 'ADMIN', true],
      ['admin@a.cm', 'ADMIN', false],
      ['auditeur@a.cm', 'AUDITOR', false],
    ] as const) {
      await prisma.user.create({
        data: { tenantId: banque, email, passwordHash, role, instanceAdmin },
      });
    }
  });

  afterAll(async () => {
    await resetTestData(prisma);
    await prisma.$disconnect();
    await app.close();
  });

  function lire(jetonAcces: string) {
    return request(app.getHttpServer())
      .get('/api/administration/reglages')
      .set('Authorization', `Bearer ${jetonAcces}`);
  }

  it('ouvre les réglages à l’administrateur de l’instance', async () => {
    const reponse = await lire(await jeton('instance@a.cm')).expect(200);
    const reglages = reponse.body as InstanceSettingsResponse;

    expect(reglages.groupes.map((groupe) => groupe.titre)).toEqual([
      'Conservation',
      'Preuve et chiffrement',
      'Accès et sessions',
      'Capture et stockage',
    ]);
    expect(reglages.locataires).toEqual([
      expect.objectContaining({ nom: 'Banque A', slug: 'banque-a', actif: true, comptes: 3 }),
    ]);
  });

  it('refuse un ADMIN qui n’administre que son locataire', async () => {
    // Le cœur de la séparation : administrer sa banque n'est pas administrer
    // l'instance qui héberge toutes les banques.
    const reponse = await lire(await jeton('admin@a.cm')).expect(403);
    expect((reponse.body as { message: string }).message).toMatch(/administrateur de l’instance/i);
  });

  it('refuse un auditeur, et refuse sans jeton', async () => {
    await lire(await jeton('auditeur@a.cm')).expect(403);
    await request(app.getHttpServer()).get('/api/administration/reglages').expect(401);
  });

  it('ne divulgue aucun secret, et désigne la clé maître par son empreinte', async () => {
    const reponse = await lire(await jeton('instance@a.cm')).expect(200);
    const corps = JSON.stringify(reponse.body);

    // Ce qui ne doit jamais sortir : les secrets de jetons, le mot de passe de
    // la base, la clé maître. Une console de conformité n'est pas un endroit
    // où l'on va chercher des secrets.
    expect(corps).not.toContain(process.env.JWT_ACCESS_SECRET as string);
    expect(corps).not.toContain(process.env.JWT_REFRESH_SECRET as string);
    expect(corps).not.toMatch(
      /JWT_ACCESS_SECRET|JWT_REFRESH_SECRET|DATABASE_URL|POSTGRES_PASSWORD/,
    );

    const preuve = (reponse.body as InstanceSettingsResponse).groupes.find(
      (groupe) => groupe.titre === 'Preuve et chiffrement',
    );
    const cle = preuve?.reglages.find((reglage) => reglage.cle.includes('clé maître'));
    expect(cle?.valeur).toMatch(/^([0-9a-f]{32}|aucune clé configurée)$/);
  });

  it('dit pourquoi les réglages sensibles ne se changent pas depuis la console', async () => {
    const reponse = await lire(await jeton('instance@a.cm')).expect(200);
    const tous = (reponse.body as InstanceSettingsResponse).groupes.flatMap(
      (groupe) => groupe.reglages,
    );

    // Un champ grisé sans explication se lit comme un défaut ; celui-ci
    // expose une décision (§9.16, §9.22).
    const proxies = tous.find((reglage) => reglage.cle === 'TRUSTED_PROXIES');
    expect(proxies?.raisonLectureSeule).toMatch(/invisible du journal/i);
    const plancher = tous.find((reglage) => reglage.cle === 'RETENTION_MIN_DAYS');
    expect(plancher?.raisonLectureSeule).toMatch(/ne protège plus rien/i);
  });

  it('réserve le périmètre système du journal à l’administrateur de l’instance', async () => {
    // Durcissement : jusqu'ici, tout ADMIN lisait les événements qu'aucun
    // locataire ne réclame (§9.2). Ce n'était pas la même responsabilité.
    await request(app.getHttpServer())
      .get('/api/audit')
      .query({ scope: 'system' })
      .set('Authorization', `Bearer ${await jeton('admin@a.cm')}`)
      .expect(403);

    await request(app.getHttpServer())
      .get('/api/audit')
      .query({ scope: 'system' })
      .set('Authorization', `Bearer ${await jeton('instance@a.cm')}`)
      .expect(200);
  });

  it('porte le privilège dans le profil, pour que le portail sache quoi montrer', async () => {
    const reponse = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${await jeton('instance@a.cm')}`)
      .expect(200);
    expect(reponse.body).toMatchObject({ instanceAdmin: true });

    const ordinaire = await request(app.getHttpServer())
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${await jeton('admin@a.cm')}`)
      .expect(200);
    expect(ordinaire.body).toMatchObject({ instanceAdmin: false });
  });
});
