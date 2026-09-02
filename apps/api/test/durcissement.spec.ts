import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppConfig } from '../src/config/config.module';
import { confianceProxy } from '../src/config/proxies';
import { entetesDeSecurite } from '../src/config/entetes';
import { LimitationConnexion } from '../src/auth/limitation-connexion.service';
import { hashPassword } from '../src/auth/password';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026';
/** Assez long pour passer la validation du DTO : c'est le mot de passe qui
 *  doit être refusé, pas la forme de la requête. */
const MAUVAIS = 'PasLeBon!2026';
const AILLEURS = '203.0.113.9';

/**
 * Durcissement des accès et des en-têtes — CLAUDE.md §9.16.
 *
 * Trois protections, et pour chacune la question qui compte : que se
 * passe-t-il quand elle n'est pas là ? Sans confiance nominative, n'importe
 * qui écrit l'adresse de son choix dans un journal qu'on ne peut pas
 * corriger. Sans limitation par adresse, un balayage de comptes n'est ralenti
 * par rien. Sans politique de contenu, le portail accepterait de charger ce
 * qu'on lui présente.
 */
describe('durcissement', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
  });

  afterAll(async () => {
    await resetTestData(prisma);
    await prisma.$disconnect();
  });

  describe('adresse du demandeur', () => {
    let tenantId: string;

    beforeEach(async () => {
      await resetTestData(prisma);
      tenantId = (await prisma.tenant.create({ data: { name: 'Banque A', slug: 'banque-a' } })).id;
      await prisma.user.create({
        data: {
          tenantId,
          email: 'auditeur@a.cm',
          passwordHash: await hashPassword(MOT_DE_PASSE),
          role: 'AUDITOR',
        },
      });
    });

    async function connecterAvecEnTete(app: INestApplication): Promise<string | null> {
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .set('X-Forwarded-For', AILLEURS)
        .send({ email: 'auditeur@a.cm', password: MOT_DE_PASSE })
        .expect(200);
      const trace = await prisma.auditEvent.findFirst({
        where: { action: 'LOGIN' },
        orderBy: { at: 'desc' },
      });
      return trace?.ip ?? null;
    }

    it('ignore un X-Forwarded-For tant qu’aucun proxy n’est déclaré', async () => {
      const app = await createTestApp();
      try {
        // Sans cette règle, un inconnu choisirait l'adresse inscrite à son nom
        // dans un journal append-only qu'aucune route ne peut corriger.
        expect(await connecterAvecEnTete(app)).not.toBe(AILLEURS);
      } finally {
        await app.close();
      }
    });

    it('retient l’adresse du demandeur quand le relais est déclaré', async () => {
      const app = await createTestApp({ trustedProxies: 'loopback' });
      try {
        // Le cas du livrable : nginx relaie, et c'est l'auditeur qu'il faut
        // inscrire au journal, pas le conteneur qui relaie.
        expect(await connecterAvecEnTete(app)).toBe(AILLEURS);
      } finally {
        await app.close();
      }
    });

    it('ne déclare aucun proxy par défaut', () => {
      expect(confianceProxy('')).toBe(false);
      expect(confianceProxy('  ')).toBe(false);
      expect(confianceProxy('10.0.0.1, 172.16.0.0/12')).toEqual(['10.0.0.1', '172.16.0.0/12']);
    });
  });

  describe('limitation des tentatives par adresse', () => {
    const MAX = 3;
    let app: INestApplication;
    let horloge: number;

    /** Configuration serrée : le défaut livré est trop large pour un test. */
    function limitationServree(): LimitationConnexion {
      const config = {
        get: (cle: string) =>
          ({ AUTH_RATE_MAX: MAX, AUTH_RATE_WINDOW_SEC: 60, AUTH_RATE_MAX_ADRESSES: 1000 })[cle],
      } as unknown as AppConfig;
      return new LimitationConnexion(config).utiliserHorloge(() => horloge);
    }

    beforeEach(async () => {
      await resetTestData(prisma);
      horloge = Date.parse('2026-09-03T08:00:00Z');
      const tenantId = (
        await prisma.tenant.create({ data: { name: 'Banque B', slug: 'banque-b' } })
      ).id;
      await prisma.user.create({
        data: {
          tenantId,
          email: 'auditeur@b.cm',
          passwordHash: await hashPassword(MOT_DE_PASSE),
          role: 'AUDITOR',
        },
      });
      app = await createTestApp({
        personnaliser: (builder) =>
          builder.overrideProvider(LimitationConnexion).useValue(limitationServree()),
      });
    });

    afterEach(async () => {
      await app.close();
    });

    function essayer(motDePasse: string) {
      return request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'auditeur@b.cm', password: motDePasse });
    }

    it('refuse une adresse qui vient d’enchaîner les échecs, et le dit une fois', async () => {
      for (let essai = 0; essai < MAX; essai += 1) {
        await essayer(MAUVAIS).expect(401);
      }

      const refus = await essayer(MAUVAIS).expect(429);
      expect(refus.headers['retry-after']).toBe('60');

      // Le blocage vaut aussi pour le bon mot de passe : la limitation porte
      // sur l'adresse, pas sur la justesse de la tentative.
      await essayer(MOT_DE_PASSE).expect(429);

      // Une entrée par épisode, pas une par requête refusée : sans quoi un
      // inconnu gonflerait à volonté un journal que rien ne peut purger.
      const blocages = await prisma.auditEvent.findMany({
        where: { action: 'LOGIN', tenantId: null },
      });
      expect(blocages).toHaveLength(1);
      expect(blocages[0]?.detail).toMatchObject({ resultat: 'bloque_par_limitation' });
      expect(blocages[0]?.userId).toBeNull();
    });

    it('rouvre l’accès quand la fenêtre est passée', async () => {
      for (let essai = 0; essai < MAX; essai += 1) {
        await essayer(MAUVAIS).expect(401);
      }
      await essayer(MOT_DE_PASSE).expect(429);

      horloge += 61_000;
      await essayer(MOT_DE_PASSE).expect(200);
    });

    it('ne compte que les échecs : un service entier derrière une même adresse n’est pas rationné', async () => {
      // Cas réel d'une banque : tout le personnel sort par une seule adresse
      // publique. Compter les connexions réussies reviendrait à rationner un
      // service au motif qu'il est nombreux.
      for (let essai = 0; essai < MAX + 2; essai += 1) {
        await essayer(MOT_DE_PASSE).expect(200);
      }
    });
  });

  describe('en-têtes de sécurité', () => {
    it('l’api ne s’autorise à charger rien du tout', async () => {
      const app = await createTestApp();
      try {
        const reponse = await request(app.getHttpServer()).get('/api/health').expect(200);
        expect(reponse.headers['content-security-policy']).toContain("default-src 'none'");
        expect(reponse.headers['content-security-policy']).toContain("frame-ancestors 'none'");
        expect(reponse.headers['cross-origin-resource-policy']).toBe('same-origin');
        expect(reponse.headers['x-content-type-options']).toBe('nosniff');
        // Rien ne doit annoncer la nature du serveur.
        expect(reponse.headers['x-powered-by']).toBeUndefined();
        // HSTS promet un site joignable en HTTPS : on ne le promet pas en clair.
        expect(reponse.headers['strict-transport-security']).toBeUndefined();
      } finally {
        await app.close();
      }
    });

    it('n’émet HSTS que derrière une terminaison TLS', () => {
      expect(entetesDeSecurite({ derriereTls: false }).hsts).toBe(false);
      expect(entetesDeSecurite({ derriereTls: true }).hsts).toMatchObject({
        includeSubDomains: true,
      });
    });
  });
});
