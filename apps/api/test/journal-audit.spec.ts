import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { hashPassword } from '../src/auth/password';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026';

/**
 * Journal d'audit — CLAUDE.md §6 et §9.11.
 *
 * C'est la pièce que vient lire un contrôleur. Elle doit répondre à « qui a
 * fait quoi, quand, sur quoi, depuis où » — et ne jamais laisser voir
 * l'activité d'un autre locataire.
 */
describe('journal d’audit', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let passwordHash: string;
  let banque: string;
  let microfinance: string;
  let auditeurId: string;
  let appelId: string;

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

    for (const [email, tenantId, role] of [
      ['admin@a.cm', banque, 'ADMIN'],
      ['superviseur@a.cm', banque, 'SUPERVISOR'],
      ['auditeur@a.cm', banque, 'AUDITOR'],
      ['admin@b.cm', microfinance, 'ADMIN'],
    ] as const) {
      const cree = await prisma.user.create({
        data: { tenantId, email, passwordHash, role },
      });
      if (email === 'auditeur@a.cm') auditeurId = cree.id;
    }

    appelId = (
      await prisma.recording.create({
        data: {
          tenantId: banque,
          refci: '16778001',
          near: '1001',
          far: '699112233',
          direction: 'outbound',
          startedAt: new Date('2026-09-01T14:30:12+01:00'),
          durationSec: 60,
          filePath: `${banque}/2026/09/appel.wav`,
          sha256: 'a'.repeat(64),
          sizeBytes: BigInt(1000),
          source: 'simulator',
        },
      })
    ).id;

    // Un journal représentatif : des actes d'un locataire, ceux d'un voisin,
    // et un dépôt que personne ne réclame.
    await prisma.auditEvent.createMany({
      data: [
        {
          tenantId: banque,
          userId: auditeurId,
          action: 'LISTEN',
          recordingId: appelId,
          ip: '10.0.0.1',
          detail: { refci: '16778001' },
          at: new Date('2026-09-01T09:00:00Z'),
        },
        {
          tenantId: banque,
          userId: auditeurId,
          action: 'SEARCH',
          ip: '10.0.0.1',
          detail: { criteres: { numero: '699' } },
          at: new Date('2026-09-02T09:00:00Z'),
        },
        {
          tenantId: banque,
          action: 'INGEST',
          recordingId: appelId,
          detail: { radical: '20260901-143012' },
          at: new Date('2026-08-30T09:00:00Z'),
        },
        {
          tenantId: microfinance,
          action: 'INGEST',
          detail: { radical: 'chez-le-voisin' },
          at: new Date('2026-09-02T10:00:00Z'),
        },
        {
          tenantId: null,
          action: 'QUARANTINE',
          detail: { motif: 'locataire inconnu' },
          at: new Date('2026-09-02T11:00:00Z'),
        },
      ],
    });
  });

  async function jeton(email: string): Promise<string> {
    const reponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: MOT_DE_PASSE })
      .expect(200);
    return (reponse.body as { accessToken: string }).accessToken;
  }

  const lire = (token: string, query = '') =>
    request(app.getHttpServer()).get(`/api/audit${query}`).set('Authorization', `Bearer ${token}`);

  describe('lecture', () => {
    it('rend les événements du locataire, le plus récent en tête', async () => {
      const reponse = await lire(await jeton('auditeur@a.cm')).expect(200);

      // La connexion de l'auditeur s'ajoute aux trois posés : 4.
      expect(reponse.body.total).toBe(4);
      const actions = reponse.body.items.map((item: { action: string }) => item.action);
      expect(actions[0]).toBe('LOGIN');
      expect(actions).toContain('LISTEN');
      expect(actions).not.toContain('QUARANTINE');
    });

    it('dit qui, quoi, quand, sur quoi et depuis où', async () => {
      const reponse = await lire(await jeton('auditeur@a.cm'), '?action=LISTEN').expect(200);
      expect(reponse.body.items[0]).toMatchObject({
        action: 'LISTEN',
        actorEmail: 'auditeur@a.cm',
        recordingId: appelId,
        // La référence PBX, pas un identifiant technique : c'est ce qu'un
        // contrôleur reconnaît.
        recordingRefci: '16778001',
        ip: '10.0.0.1',
        detail: { refci: '16778001' },
      });
    });

    it('n’attribue aucun auteur à ce que fait le produit lui-même', async () => {
      const reponse = await lire(await jeton('auditeur@a.cm'), '?action=INGEST').expect(200);
      expect(reponse.body.items[0]).toMatchObject({ action: 'INGEST', actorEmail: null });
    });

    it('ne laisse jamais voir le journal d’un autre locataire', async () => {
      const reponse = await lire(await jeton('auditeur@a.cm')).expect(200);
      const details = JSON.stringify(reponse.body.items);
      expect(details).not.toMatch(/chez-le-voisin/);
    });

    it.each([
      ['par action', '?action=SEARCH', 1],
      ['par auteur, sur un fragment d’adresse', '?actor=auditeur', 3],
      ['par jour', '?from=2026-09-01&to=2026-09-01', 1],
    ])('filtre %s', async (_libelle, query, attendu) => {
      const reponse = await lire(await jeton('auditeur@a.cm'), query).expect(200);
      expect(reponse.body.total).toBe(attendu);
    });

    it('filtre sur un enregistrement : toute la vie d’un appel', async () => {
      const reponse = await lire(await jeton('auditeur@a.cm'), `?recordingId=${appelId}`).expect(
        200,
      );
      expect(reponse.body.total).toBe(2);
      expect(reponse.body.items.map((item: { action: string }) => item.action).sort()).toEqual([
        'INGEST',
        'LISTEN',
      ]);
    });

    it('pagine sur le résultat filtré', async () => {
      const reponse = await lire(await jeton('auditeur@a.cm'), '?pageSize=2').expect(200);
      expect(reponse.body.items).toHaveLength(2);
      expect(reponse.body.pageCount).toBe(2);
    });

    it.each([
      ['jour inexistant', '?from=2026-02-30'],
      ['action inconnue', '?action=DANSER'],
      ['filtre inconnu', '?operateur=mtn'],
      ['enregistrement mal formé', '?recordingId=pas-un-uuid'],
    ])('refuse : %s', async (_libelle, query) => {
      await lire(await jeton('auditeur@a.cm'), query).expect(400);
    });
  });

  describe('événements système', () => {
    it('sont réservés à l’ADMIN de l’instance', async () => {
      const reponse = await lire(await jeton('admin@a.cm'), '?scope=system').expect(200);
      expect(reponse.body.total).toBe(1);
      expect(reponse.body.items[0]).toMatchObject({ action: 'QUARANTINE', tenantId: null });
    });

    it('restent hors de portée d’un AUDITOR', async () => {
      await lire(await jeton('auditeur@a.cm'), '?scope=system').expect(403);
      await lire(await jeton('auditeur@a.cm'), '?scope=all').expect(403);
    });

    it('se joignent au journal du locataire quand l’ADMIN le demande', async () => {
      // Un seul jeton pour les deux lectures : chaque connexion inscrirait
      // sinon un LOGIN de plus entre les deux mesures.
      const admin = await jeton('admin@a.cm');
      const parDefaut = await lire(admin).expect(200);
      const avecSysteme = await lire(admin, '?scope=all').expect(200);
      expect(avecSysteme.body.total).toBe(parDefaut.body.total + 1);
    });
  });

  describe('habilitation', () => {
    it('refuse le journal au SUPERVISOR', async () => {
      // Le journal dit qui a entendu quoi : le donner à lire à qui n'a pas
      // l'habilitation d'écoute reviendrait à la contourner (§9.9).
      await lire(await jeton('superviseur@a.cm')).expect(403);
    });

    it('refuse une lecture non authentifiée', async () => {
      await request(app.getHttpServer()).get('/api/audit').expect(401);
    });

    it('n’expose aucune route d’écriture : le journal est append-only', async () => {
      await request(app.getHttpServer())
        .post('/api/audit')
        .set('Authorization', `Bearer ${await jeton('admin@a.cm')}`)
        .send({ action: 'LOGIN' })
        .expect(404);

      const premier = await prisma.auditEvent.findFirstOrThrow();
      await expect(
        prisma.auditEvent.update({ where: { id: premier.id }, data: { action: 'LOGIN' } }),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('export CSV', () => {
    it('rend un fichier ouvrable par un tableur français', async () => {
      const reponse = await lire(await jeton('auditeur@a.cm'), '/export.csv').expect(200);

      expect(reponse.headers['content-type']).toContain('text/csv');
      expect(reponse.headers['content-disposition']).toContain('journal-audit.csv');

      const texte = reponse.text;
      // Marque d'ordre d'octets, sans quoi Excel massacre les accents.
      expect(texte.charCodeAt(0)).toBe(0xfeff);
      expect(texte).toContain('horodatage_utc;action;auteur');
      expect(texte).toContain('"LISTEN"');
      expect(texte).toContain('"auditeur@a.cm"');
    });

    it('n’exporte que ce que le filtre retient', async () => {
      const reponse = await lire(await jeton('auditeur@a.cm'), '/export.csv?action=LISTEN').expect(
        200,
      );
      const lignes = reponse.text.trim().split('\r\n');
      expect(lignes).toHaveLength(2); // en-tête + une ligne
      expect(reponse.headers['x-audit-lignes']).toBe('1');
      expect(reponse.headers['x-audit-tronque']).toBe('false');
    });

    it('s’inscrit lui-même au journal : un extrait qui sort est une pièce', async () => {
      await lire(await jeton('auditeur@a.cm'), '/export.csv?action=LISTEN').expect(200);

      const trace = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'EXPORT' },
        orderBy: { at: 'desc' },
      });
      expect(trace.detail).toMatchObject({
        objet: 'journal-audit',
        lignes: 1,
        tronque: false,
        criteres: { action: 'LISTEN' },
      });
    });

    it('neutralise une formule glissée dans un champ libre', async () => {
      // Un motif de conservation forcée est saisi par un humain et finira
      // dans un tableur : il ne doit pas s'y exécuter.
      await prisma.auditEvent.create({
        data: {
          tenantId: banque,
          userId: auditeurId,
          action: 'HOLD_SET',
          detail: { motif: '=1+1' },
        },
      });

      const reponse = await lire(await jeton('admin@a.cm'), '/export.csv?action=HOLD_SET').expect(
        200,
      );
      expect(reponse.text).not.toMatch(/;"=/);
    });

    it('ne franchit pas le cloisonnement', async () => {
      const reponse = await lire(await jeton('auditeur@a.cm'), '/export.csv').expect(200);
      expect(reponse.text).not.toMatch(/chez-le-voisin/);
    });
  });
});
