import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import {
  politiqueParDefaut,
  type PolicyVersionDetail,
  type PolicyVersionSummary,
  type RecordingPolicy,
} from '@voxecho/shared';
import { hashPassword } from '../src/auth/password';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026';

/**
 * Référentiel de politiques d'enregistrement — CLAUDE.md §9.23.
 *
 * Ce que ces cas protègent : une version publiée est **opposable**. C'est elle
 * qui expliquera, des mois plus tard, pourquoi tel appel n'a pas été
 * enregistré. Elle doit donc être numérotée, motivée, immuable, et lisible par
 * qui n'a pas le droit de la changer.
 */
describe('politiques d’enregistrement', () => {
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

  /** Politique d'exemple : la salle des marchés enregistrée, la RH exclue. */
  function politiqueBanque(): RecordingPolicy {
    return {
      ...politiqueParDefaut(),
      parDefaut: 'sample',
      tauxParDefautPourcent: 20,
      exclusions: ['1090', '1091'],
      motifExclusions: 'Ressources humaines et médecine du travail',
      listes: [{ nom: 'Salle des marchés', numeros: ['1001', '1002'] }],
      regles: [
        {
          libelle: 'Salle des marchés',
          critere: 'liste',
          valeur: 'Salle des marchés',
          decision: 'always',
          annonce: true,
          pauseAutorisee: true,
        },
      ],
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
    for (const [email, role] of [
      ['admin@a.cm', 'ADMIN'],
      ['auditeur@a.cm', 'AUDITOR'],
      ['superviseur@a.cm', 'SUPERVISOR'],
    ] as const) {
      await prisma.user.create({ data: { tenantId: banque, email, passwordHash, role } });
    }
  });

  function requete(chemin: string, jetonAcces: string) {
    return request(app.getHttpServer())
      .get(`/api/policies${chemin}`)
      .set('Authorization', `Bearer ${jetonAcces}`);
  }

  /** Non `async` : on rend la requête supertest, qui se chaîne avec `.expect`. */
  function ecrireBrouillon(document: RecordingPolicy, jetonAcces: string) {
    return request(app.getHttpServer())
      .put('/api/policies/brouillon')
      .set('Authorization', `Bearer ${jetonAcces}`)
      .send({ document });
  }

  function publier(note: string, jetonAcces: string) {
    return request(app.getHttpServer())
      .post('/api/policies/brouillon/publier')
      .set('Authorization', `Bearer ${jetonAcces}`)
      .send({ note });
  }

  it('n’applique aucune politique tant qu’aucune n’est publiée', async () => {
    // Ne pas enregistrer doit résulter d'une décision écrite : sans politique,
    // c'est le défaut du produit qui vaut, et il enregistre tout.
    const reponse = await requete('/en-vigueur', await jeton('auditeur@a.cm')).expect(200);
    expect(reponse.body).toEqual({});
  });

  it('écrit un brouillon, le remplace, et n’en garde qu’un', async () => {
    const admin = await jeton('admin@a.cm');
    await ecrireBrouillon(politiqueBanque(), admin).expect(200);
    await ecrireBrouillon(
      { ...politiqueBanque(), parDefaut: 'always', tauxParDefautPourcent: undefined },
      admin,
    ).expect(200);

    const versions = (await requete('', admin).expect(200)).body as PolicyVersionSummary[];
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version: 1, status: 'draft' });

    // Un brouillon n'a aucun effet : rien n'est en vigueur, et rien au journal.
    expect((await requete('/en-vigueur', admin).expect(200)).body).toEqual({});
    expect(await prisma.auditEvent.count({ where: { action: 'POLICY_SET' } })).toBe(0);
  });

  it('refuse une politique que le contrat rejette, en disant quoi', async () => {
    const reponse = await ecrireBrouillon(
      { ...politiqueParDefaut(), parDefaut: 'sample' } as RecordingPolicy,
      await jeton('admin@a.cm'),
    ).expect(400);

    const corps = reponse.body as { details: string[] };
    expect(corps.details.join(' ')).toMatch(/échantillonnage sans taux/);
  });

  it('publie, numérote, motive et trace', async () => {
    const admin = await jeton('admin@a.cm');
    await ecrireBrouillon(politiqueBanque(), admin).expect(200);

    const publiee = (
      await publier(
        'Enregistrement sélectif : marchés systématique, RH exclue, 20 % ailleurs',
        admin,
      ).expect(200)
    ).body as PolicyVersionDetail;

    expect(publiee).toMatchObject({
      version: 1,
      status: 'published',
      publishedByEmail: 'admin@a.cm',
    });
    expect(publiee.sha256).toHaveLength(64);
    expect(publiee.resume).toEqual({ parDefaut: 'sample', regles: 1, exclusions: 2, listes: 1 });

    const trace = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'POLICY_SET' } });
    expect(trace.detail).toMatchObject({
      version: 1,
      versionPrecedente: null,
      exclusions: 2,
      // Ce qui intéresse un contrôleur : cette version renonce-t-elle à des
      // enregistrements ?
      renonce: true,
    });
  });

  it('refuse de publier sans note, et sans brouillon', async () => {
    const admin = await jeton('admin@a.cm');
    await ecrireBrouillon(politiqueBanque(), admin).expect(200);

    // Renoncer d'avance à des preuves se motive, comme une purge (§9.7).
    await publier('bref', admin).expect(400);
    await publier('Motif suffisamment explicite pour un contrôle', admin).expect(200);
    await publier('Motif suffisamment explicite pour un contrôle', admin).expect(404);
  });

  it('refuse de republier un brouillon identique à la version en vigueur', async () => {
    const admin = await jeton('admin@a.cm');
    await ecrireBrouillon(politiqueBanque(), admin).expect(200);
    await publier('Première politique d’enregistrement sélectif', admin).expect(200);

    await ecrireBrouillon(politiqueBanque(), admin).expect(200);
    const conflit = await publier('Aucun changement réel', admin).expect(409);

    // Empiler des versions identiques brouillerait un historique dont toute la
    // valeur est de dater les changements.
    expect((conflit.body as { message: string }).message).toMatch(/identique à la version 1/);
  });

  it('numérote la suite et garde l’historique complet', async () => {
    const admin = await jeton('admin@a.cm');
    await ecrireBrouillon(politiqueBanque(), admin).expect(200);
    await publier('Première politique d’enregistrement sélectif', admin).expect(200);

    await ecrireBrouillon({ ...politiqueBanque(), tauxParDefautPourcent: 50 }, admin).expect(200);
    const seconde = (await publier('Échantillonnage porté à 50 %', admin).expect(200))
      .body as PolicyVersionDetail;

    expect(seconde.version).toBe(2);
    const versions = (await requete('', admin).expect(200)).body as PolicyVersionSummary[];
    expect(versions.map((v) => v.version)).toEqual([2, 1]);

    const enVigueur = (await requete('/en-vigueur', admin).expect(200)).body as PolicyVersionDetail;
    expect(enVigueur.version).toBe(2);
  });

  it('rend une version publiée immuable, jusque dans la base', async () => {
    const admin = await jeton('admin@a.cm');
    await ecrireBrouillon(politiqueBanque(), admin).expect(200);
    await publier('Première politique d’enregistrement sélectif', admin).expect(200);

    const publiee = await prisma.recordingPolicyVersion.findFirstOrThrow({
      where: { tenantId: banque, status: 'published' },
    });

    // Aucune route ne le permet ; le garde-fou en base couvre le reste, comme
    // pour le journal d'audit (§5). Réécrire une politique publiée reviendrait
    // à réécrire la raison d'une absence de preuve.
    await expect(
      prisma.recordingPolicyVersion.update({
        where: { id: publiee.id },
        data: { note: 'réécrite après coup' },
      }),
    ).rejects.toThrow(/immuable/);
    await expect(
      prisma.recordingPolicyVersion.delete({ where: { id: publiee.id } }),
    ).rejects.toThrow(/immuable/);
  });

  it('ouvre la lecture aux trois rôles et réserve l’écriture à l’ADMIN', async () => {
    const admin = await jeton('admin@a.cm');
    await ecrireBrouillon(politiqueBanque(), admin).expect(200);
    await publier('Première politique d’enregistrement sélectif', admin).expect(200);

    // « Quelle politique s'appliquait ce jour-là ? » est une question de
    // conformité : un auditeur doit pouvoir y répondre seul.
    await requete('/en-vigueur', await jeton('auditeur@a.cm')).expect(200);
    await requete('/en-vigueur', await jeton('superviseur@a.cm')).expect(200);

    const auditeur = await jeton('auditeur@a.cm');
    await ecrireBrouillon(politiqueBanque(), auditeur).expect(403);
    await publier('Tentative sans habilitation', auditeur).expect(403);
    await requete('/brouillon', auditeur).expect(403);
  });

  it('cloisonne : la politique d’un locataire ne s’applique qu’à lui', async () => {
    const voisine = await prisma.tenant.create({ data: { name: 'MFI B', slug: 'mfi-b' } });
    await prisma.user.create({
      data: {
        tenantId: voisine.id,
        email: 'admin@b.cm',
        passwordHash: await hashPassword(MOT_DE_PASSE),
        role: 'ADMIN',
      },
    });

    const admin = await jeton('admin@a.cm');
    await ecrireBrouillon(politiqueBanque(), admin).expect(200);
    await publier('Première politique d’enregistrement sélectif', admin).expect(200);

    expect((await requete('', await jeton('admin@b.cm')).expect(200)).body).toEqual([]);
    expect((await requete('/en-vigueur', await jeton('admin@b.cm')).expect(200)).body).toEqual({});
  });
});
