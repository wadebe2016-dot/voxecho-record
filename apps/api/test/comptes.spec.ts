import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { TemporaryPasswordResponse, UserSummary } from '@voxecho/shared';
import { hashPassword } from '../src/auth/password';
import { motDePasseProvisoire, verifierMotDePasse } from '../src/auth/password-policy';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026-portail';

/**
 * Gestion des comptes — CLAUDE.md §9.26.
 *
 * Ce que ces cas protègent : donner à quelqu'un le droit d'entendre des
 * conversations de clients est l'acte le plus lourd de la console. Il se trace,
 * il ne s'auto-attribue pas, et il ne doit jamais fermer la porte de
 * l'instance derrière lui.
 */
describe('gestion des comptes', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let banque: string;

  async function jeton(email: string, motDePasse = MOT_DE_PASSE): Promise<string> {
    const reponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: motDePasse })
      .expect(200);
    return (reponse.body as { accessToken: string }).accessToken;
  }

  function avec(jetonAcces: string) {
    return {
      get: (chemin: string) =>
        request(app.getHttpServer())
          .get(`/api${chemin}`)
          .set('Authorization', `Bearer ${jetonAcces}`),
      post: (chemin: string) =>
        request(app.getHttpServer())
          .post(`/api${chemin}`)
          .set('Authorization', `Bearer ${jetonAcces}`),
      patch: (chemin: string) =>
        request(app.getHttpServer())
          .patch(`/api${chemin}`)
          .set('Authorization', `Bearer ${jetonAcces}`),
    };
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
    const passwordHash = await hashPassword(MOT_DE_PASSE);
    for (const [email, role, instanceAdmin] of [
      ['admin@a.cm', 'ADMIN', true],
      ['admin2@a.cm', 'ADMIN', false],
      ['auditeur@a.cm', 'AUDITOR', false],
    ] as const) {
      await prisma.user.create({
        data: { tenantId: banque, email, passwordHash, role, instanceAdmin },
      });
    }
  });

  describe('politique de mot de passe', () => {
    it('refuse ce qui se devine, accepte ce qui tient', () => {
      const options = { longueurMinimale: 12, email: 'auditeur@a.cm' };
      expect(verifierMotDePasse('court', options).ok).toBe(false);
      expect(verifierMotDePasse('motdepasse2026!', options).ok).toBe(false);
      // Un mot de passe qui contient l'adresse de son propriétaire se devine
      // depuis la seule liste des comptes.
      expect(verifierMotDePasse('auditeur-2026-!', options).ok).toBe(false);
      expect(verifierMotDePasse('aaaaaaaaaaaaaa', options).ok).toBe(false);
      expect(verifierMotDePasse('Kwessi!Ngoma-42', options).ok).toBe(true);
    });

    it('produit un provisoire lisible et sans caractère ambigu', () => {
      const provisoire = motDePasseProvisoire();
      // Il se dicte au téléphone : ni O ni 0, ni I ni 1.
      expect(provisoire).toMatch(/^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){3}$/);
      expect(motDePasseProvisoire()).not.toBe(provisoire);
    });
  });

  describe('création', () => {
    it('crée un compte, rend un mot de passe provisoire une seule fois, et trace', async () => {
      const reponse = await avec(await jeton('admin@a.cm'))
        .post('/users')
        .send({ email: 'nouveau@a.cm', role: 'AUDITOR' })
        .expect(201);

      const corps = reponse.body as TemporaryPasswordResponse;
      expect(corps.compte).toMatchObject({
        email: 'nouveau@a.cm',
        role: 'AUDITOR',
        active: true,
        mustChangePassword: true,
      });
      expect(corps.motDePasseProvisoire).toMatch(/^[A-HJ-NP-Z2-9-]{19}$/);

      // Le provisoire n'est stocké nulle part en clair : la liste ne le rend
      // pas, et rien ne permet de le relire.
      const liste = (
        await avec(await jeton('admin@a.cm'))
          .get('/users')
          .expect(200)
      ).body as UserSummary[];
      expect(JSON.stringify(liste)).not.toContain(corps.motDePasseProvisoire);

      const trace = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'USER_SET' } });
      expect(trace.detail).toMatchObject({
        acte: 'creation',
        cible: 'nouveau@a.cm',
        role: 'AUDITOR',
      });
    });

    it('refuse une adresse déjà prise, sans dire où', async () => {
      const reponse = await avec(await jeton('admin@a.cm'))
        .post('/users')
        .send({ email: 'auditeur@a.cm', role: 'AUDITOR' })
        .expect(409);
      // L'unicité est globale (§9.1) : on refuse sans révéler chez quel
      // locataire l'adresse est déjà utilisée.
      expect((reponse.body as { message: string }).message).not.toMatch(/banque|locataire/i);
    });
  });

  describe('mot de passe provisoire', () => {
    it('barre tout le portail tant qu’il n’est pas renouvelé', async () => {
      const creation = await avec(await jeton('admin@a.cm'))
        .post('/users')
        .send({ email: 'nouveau@a.cm', role: 'AUDITOR' })
        .expect(201);
      const { motDePasseProvisoire: provisoire } = creation.body as TemporaryPasswordResponse;

      const acces = await jeton('nouveau@a.cm', provisoire);

      // Masquer le portail ne suffirait pas : l'api reste joignable.
      await avec(acces).get('/recordings').expect(403);
      await avec(acces).get('/policies/en-vigueur').expect(403);
      // Sauf ce qui sert à en sortir.
      await avec(acces).get('/auth/me').expect(200);
    });

    it('libère l’accès une fois renouvelé, et révoque les sessions ouvertes', async () => {
      const creation = await avec(await jeton('admin@a.cm'))
        .post('/users')
        .send({ email: 'nouveau@a.cm', role: 'AUDITOR' })
        .expect(201);
      const { motDePasseProvisoire: provisoire } = creation.body as TemporaryPasswordResponse;
      const acces = await jeton('nouveau@a.cm', provisoire);

      const change = await avec(acces)
        .post('/auth/password')
        .send({ ancien: provisoire, nouveau: 'Ngoma!Kwessi-2026' })
        .expect(200);

      // La réponse rend des jetons neufs : le drapeau voyage dans le jeton, et
      // sans cela le compte resterait bloqué jusqu'à son expiration.
      const nouveaux = change.body as { accessToken: string };
      await request(app.getHttpServer())
        .get('/api/recordings')
        .set('Authorization', `Bearer ${nouveaux.accessToken}`)
        .expect(200);

      // L'ancien jeton d'accès reste porteur du drapeau : il ne rouvre rien.
      await avec(acces).get('/recordings').expect(403);
      expect(
        await prisma.refreshToken.count({
          where: { user: { email: 'nouveau@a.cm' }, revokedAt: null },
        }),
      ).toBe(1);
    });

    it('refuse un nouveau mot de passe faible, ou identique à l’ancien', async () => {
      const creation = await avec(await jeton('admin@a.cm'))
        .post('/users')
        .send({ email: 'nouveau@a.cm', role: 'AUDITOR' })
        .expect(201);
      const { motDePasseProvisoire: provisoire } = creation.body as TemporaryPasswordResponse;
      const acces = await jeton('nouveau@a.cm', provisoire);

      const faible = await avec(acces)
        .post('/auth/password')
        .send({ ancien: provisoire, nouveau: 'motdepasse123' })
        .expect(400);
      expect((faible.body as { details: string[] }).details.join(' ')).toMatch(/courant/i);

      await avec(acces)
        .post('/auth/password')
        .send({ ancien: provisoire, nouveau: provisoire })
        .expect(400);
    });
  });

  describe('modification', () => {
    it('change un rôle et le consigne avec son avant et son après', async () => {
      const cible = await prisma.user.findFirstOrThrow({ where: { email: 'auditeur@a.cm' } });

      const reponse = await avec(await jeton('admin@a.cm'))
        .patch(`/users/${cible.id}`)
        .send({ role: 'SUPERVISOR' })
        .expect(200);
      expect((reponse.body as UserSummary).role).toBe('SUPERVISOR');

      const trace = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'USER_SET' },
        orderBy: { at: 'desc' },
      });
      expect(trace.detail).toMatchObject({
        acte: 'modification',
        cible: 'auditeur@a.cm',
        avant: { role: 'AUDITOR', active: true },
        apres: { role: 'SUPERVISOR', active: true },
      });
    });

    it('désactive un compte plutôt que de le supprimer', async () => {
      const cible = await prisma.user.findFirstOrThrow({ where: { email: 'auditeur@a.cm' } });
      await avec(await jeton('admin@a.cm'))
        .patch(`/users/${cible.id}`)
        .send({ active: false })
        .expect(200);

      // Le compte subsiste : le journal d'audit référence son auteur, et
      // l'effacer effacerait le lien vers ce qu'il a écouté (§5).
      const apres = await prisma.user.findUniqueOrThrow({ where: { id: cible.id } });
      expect(apres.active).toBe(false);
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'auditeur@a.cm', password: MOT_DE_PASSE })
        .expect(403);
    });

    it('interdit à un administrateur de modifier son propre compte', async () => {
      const soi = await prisma.user.findFirstOrThrow({ where: { email: 'admin@a.cm' } });
      const reponse = await avec(await jeton('admin@a.cm'))
        .patch(`/users/${soi.id}`)
        .send({ role: 'AUDITOR' })
        .expect(400);

      // Se rétrograder soi-même, c'est se fermer la porte de l'intérieur.
      expect((reponse.body as { message: string }).message).toMatch(/un autre administrateur/i);
    });

    it('ne franchit pas le cloisonnement entre locataires', async () => {
      const voisine = await prisma.tenant.create({ data: { name: 'MFI B', slug: 'mfi-b' } });
      const chezElle = await prisma.user.create({
        data: {
          tenantId: voisine.id,
          email: 'admin@b.cm',
          passwordHash: await hashPassword(MOT_DE_PASSE),
          role: 'ADMIN',
        },
      });

      await avec(await jeton('admin@a.cm'))
        .patch(`/users/${chezElle.id}`)
        .send({ active: false })
        .expect(404);
      expect(
        (
          await avec(await jeton('admin@a.cm'))
            .get('/users')
            .expect(200)
        ).body,
      ).toHaveLength(3);
    });
  });

  describe('dernier administrateur de l’instance', () => {
    it('refuse de le désactiver ou de le rétrograder', async () => {
      // Réserve du §9.22 : sans lui, la console se ferme à tout le monde et il
      // faut un accès au serveur pour la rouvrir.
      const dernier = await prisma.user.findFirstOrThrow({ where: { email: 'admin@a.cm' } });
      const admin2 = await jeton('admin2@a.cm');

      const desactivation = await avec(admin2)
        .patch(`/users/${dernier.id}`)
        .send({ active: false })
        .expect(400);
      expect((desactivation.body as { message: string }).message).toMatch(
        /dernier administrateur/i,
      );

      await avec(admin2).patch(`/users/${dernier.id}`).send({ role: 'AUDITOR' }).expect(400);
    });

    it('l’autorise dès qu’un autre administrateur d’instance existe', async () => {
      await prisma.user.update({
        where: { email: 'admin2@a.cm' },
        data: { instanceAdmin: true },
      });
      const premier = await prisma.user.findFirstOrThrow({ where: { email: 'admin@a.cm' } });

      // Il ne restera qu'un administrateur **local** : depuis le §9.37,
      // l'opération se refuse d'abord et se confirme ensuite.
      await avec(await jeton('admin2@a.cm'))
        .patch(`/users/${premier.id}`)
        .send({ active: false, acceptSansContreValidation: true })
        .expect(200);
    });
  });

  describe('réinitialisation', () => {
    it('rend un nouveau provisoire, révoque les sessions et déverrouille', async () => {
      const cible = await prisma.user.findFirstOrThrow({ where: { email: 'auditeur@a.cm' } });
      await jeton('auditeur@a.cm');
      await prisma.user.update({
        where: { id: cible.id },
        data: { failedLoginAttempts: 4, lockedUntil: new Date(Date.now() + 600_000) },
      });

      const reponse = await avec(await jeton('admin@a.cm'))
        .post(`/users/${cible.id}/reinitialiser`)
        .expect(200);
      const corps = reponse.body as TemporaryPasswordResponse;

      expect(corps.compte.mustChangePassword).toBe(true);
      expect(corps.compte.lockedUntil).toBeNull();
      expect(
        await prisma.refreshToken.count({ where: { userId: cible.id, revokedAt: null } }),
      ).toBe(0);

      // Le nouveau provisoire ouvre la session ; l'ancien mot de passe non.
      await jeton('auditeur@a.cm', corps.motDePasseProvisoire);
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'auditeur@a.cm', password: MOT_DE_PASSE })
        .expect(401);
    });
  });

  describe('habilitations', () => {
    it('réserve la gestion des comptes à l’ADMIN du locataire', async () => {
      const auditeur = await jeton('auditeur@a.cm');
      await avec(auditeur).get('/users').expect(403);
      await avec(auditeur).post('/users').send({ email: 'x@a.cm', role: 'AUDITOR' }).expect(403);
    });
  });
});
