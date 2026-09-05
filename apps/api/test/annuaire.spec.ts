import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { ATTRIBUTS_DEFAUT, ANNUAIRE_FILTRE_DEFAUT } from '@voxecho/shared';
import { hashPassword } from '../src/auth/password';
import { AnnuaireService } from '../src/settings/annuaire.service';
import { AnnuaireInjoignable, type Annuaire, type CompteAnnuaire } from '../src/settings/annuaire-client';
import { echapperFiltre } from '../src/settings/annuaire-client';
import { InstanceSettingsService } from '../src/settings/instance-settings.service';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Conformite-2026-Douala!';
const GROUPE_ADMINS = 'CN=VoxEcho-Admins,OU=Groupes,DC=lab,DC=voxecho,DC=local';
const GROUPE_AUDITEURS = 'CN=VoxEcho-Auditeurs,OU=Groupes,DC=lab,DC=voxecho,DC=local';

/** Un annuaire de laboratoire, en mémoire. */
class AnnuaireSimule implements Annuaire {
  comptes = new Map<string, CompteAnnuaire & { motDePasse: string }>();
  injoignable = false;

  ajouter(
    login: string,
    groupes: string[],
    email = `${login}@lab.voxecho.local`,
    motDePasse = 'Annuaire-2026!',
  ): void {
    this.comptes.set(login, {
      dn: `CN=${login},OU=Utilisateurs,DC=lab,DC=voxecho,DC=local`,
      externalId: `guid-${login}`,
      login,
      email,
      nomAffiche: login,
      groupes,
      motDePasse,
    });
  }

  chercher(login: string): Promise<CompteAnnuaire | null> {
    if (this.injoignable) return Promise.reject(new AnnuaireInjoignable('connexion refusée'));
    return Promise.resolve(this.comptes.get(login) ?? null);
  }

  verifierIdentifiants(dn: string, motDePasse: string): Promise<boolean> {
    if (this.injoignable) return Promise.reject(new AnnuaireInjoignable('connexion refusée'));
    const compte = [...this.comptes.values()].find((c) => c.dn === dn);
    return Promise.resolve(compte !== undefined && compte.motDePasse === motDePasse);
  }

  listerParIdentifiants(): Promise<CompteAnnuaire[]> {
    return Promise.resolve([...this.comptes.values()]);
  }
}

/**
 * Annuaire d'entreprise — CLAUDE.md §9.37.
 *
 * Trois invariants s'y jouent : rien n'est créé sans correspondance écrite, un
 * compte local n'est jamais repris en silence, et il reste toujours un
 * administrateur local actif.
 */
describe('annuaire', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let banque: string;
  let simule: AnnuaireSimule;

  async function jeton(email: string, motDePasse = MOT_DE_PASSE): Promise<string> {
    const reponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: motDePasse })
      .expect(200);
    return (reponse.body as { accessToken: string }).accessToken;
  }

  const avec = (token: string) => ({
    get: (url: string) =>
      request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`),
    put: (url: string) =>
      request(app.getHttpServer()).put(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) =>
      request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${token}`),
    patch: (url: string) =>
      request(app.getHttpServer()).patch(url).set('Authorization', `Bearer ${token}`),
  });

  const connexion = (email: string, password: string) =>
    request(app.getHttpServer()).post('/api/auth/login').send({ email, password });

  /** Active l'annuaire avec les deux règles du laboratoire. */
  async function activer(regles = deuxRegles()): Promise<void> {
    const instance = await jeton('instance@a.cm');
    const actuel = await avec(instance).get('/api/administration/annuaire').expect(200);
    await avec(instance)
      .put('/api/administration/annuaire')
      .send({
        version: actuel.body.version,
        bindMotDePasse: 'secret-de-liaison',
        reglages: {
          actif: true,
          url: 'ldaps://dc01.lab.voxecho.local:636',
          startTls: false,
          verifierCertificat: true,
          acPem: null,
          baseDn: 'DC=lab,DC=voxecho,DC=local',
          bindDn: 'CN=svc-voxecho,OU=Services,DC=lab,DC=voxecho,DC=local',
          filtre: ANNUAIRE_FILTRE_DEFAUT,
          attributs: ATTRIBUTS_DEFAUT,
          regles,
          synchro: { actif: true, intervalleHeures: 6 },
        },
      })
      .expect(200);
  }

  const deuxRegles = () => [
    { groupeDn: GROUPE_ADMINS, role: 'ADMIN' as const, tenantId: banque },
    { groupeDn: GROUPE_AUDITEURS, role: 'AUDITOR' as const, tenantId: banque },
  ];

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
    await prisma.instanceSetting.deleteMany();
    app.get(InstanceSettingsService).oublier();

    simule = new AnnuaireSimule();
    app.get(AnnuaireService).fabriquerAnnuaire = () => simule;

    banque = (
      await prisma.tenant.create({ data: { name: 'Banque Méridienne', slug: 'banque-a' } })
    ).id;
    for (const [email, role, instanceAdmin] of [
      ['instance@a.cm', 'ADMIN', true],
      ['admin@a.cm', 'ADMIN', false],
    ] as const) {
      await prisma.user.create({
        data: {
          tenantId: banque,
          email,
          passwordHash: await hashPassword(MOT_DE_PASSE),
          role,
          instanceAdmin,
        },
      });
    }
  });

  describe('les réglages', () => {
    it('ne rend jamais le mot de passe de liaison', async () => {
      await activer();
      const lu = await avec(await jeton('instance@a.cm'))
        .get('/api/administration/annuaire')
        .expect(200);

      expect(lu.body.reglages.bindMotDePasse).toBe('********');
      expect(JSON.stringify(lu.body)).not.toContain('secret-de-liaison');

      // Ni en base : le secret y vit chiffré, jamais en clair.
      const ligne = await prisma.instanceSetting.findUniqueOrThrow({ where: { key: 'annuaire' } });
      expect(JSON.stringify(ligne.value)).not.toContain('secret-de-liaison');
      expect(JSON.stringify(ligne.value)).toContain('vxs1:');
    });

    it('conserve le secret quand l’écriture ne le remplace pas', async () => {
      await activer();
      const instance = await jeton('instance@a.cm');
      const lu = await avec(instance).get('/api/administration/annuaire').expect(200);

      // Le portail renvoie la section sans mot de passe : l'ancien demeure.
      await avec(instance)
        .put('/api/administration/annuaire')
        .send({
          version: lu.body.version,
          reglages: { ...lu.body.reglages, bindMotDePasse: undefined, startTls: true },
        })
        .expect(200);

      const ligne = await prisma.instanceSetting.findUniqueOrThrow({ where: { key: 'annuaire' } });
      expect(JSON.stringify(ligne.value)).toContain('vxs1:');
    });

    it('ne masque pas le secret au journal d’audit, il l’en écarte', async () => {
      await activer();
      const trace = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'SETTINGS_SET' },
        orderBy: { at: 'desc' },
      });
      expect(JSON.stringify(trace.detail)).not.toContain('secret-de-liaison');
      expect(JSON.stringify(trace.detail)).toContain('********');
      expect(trace.detail).toMatchObject({ secretRemplace: true });
    });

    it('refuse un filtre sans {login}', async () => {
      const instance = await jeton('instance@a.cm');
      const refus = await avec(instance)
        .put('/api/administration/annuaire')
        .send({
          version: 0,
          reglages: {
            actif: false,
            url: null,
            startTls: false,
            verifierCertificat: true,
            acPem: null,
            baseDn: null,
            bindDn: null,
            // Sans `{login}`, le filtre rendrait toujours le même compte, et
            // n'importe qui entrerait sous l'identité de celui-là.
            filtre: '(objectClass=user)',
            attributs: ATTRIBUTS_DEFAUT,
            regles: [],
            synchro: { actif: true, intervalleHeures: 6 },
          },
        })
        .expect(400);
      expect(JSON.stringify(refus.body)).toMatch(/\{login\}/);
    });

    it('réserve l’onglet à l’administrateur d’instance', async () => {
      await avec(await jeton('admin@a.cm')).get('/api/administration/annuaire').expect(403);
    });
  });

  describe('le test de connexion', () => {
    it('rend les attributs, les groupes et la correspondance', async () => {
      simule.ajouter('mbarga', [GROUPE_AUDITEURS]);
      await activer();

      const resultat = await avec(await jeton('instance@a.cm'))
        .post('/api/administration/annuaire/test')
        .send({ login: 'mbarga' })
        .expect(201);

      expect(resultat.body.bind.reussi).toBe(true);
      expect(resultat.body.recherche).toMatchObject({ trouve: true, login: 'mbarga' });
      expect(resultat.body.recherche.groupes).toEqual([GROUPE_AUDITEURS]);
      expect(resultat.body.correspondance).toMatchObject({ role: 'AUDITOR' });
    });

    it('s’inscrit au journal même en échec', async () => {
      simule.injoignable = true;
      await activer();

      const resultat = await avec(await jeton('instance@a.cm'))
        .post('/api/administration/annuaire/test')
        .send({ login: 'mbarga' })
        .expect(201);
      expect(resultat.body.bind.reussi).toBe(false);

      const trace = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'SETTINGS_TEST' },
        orderBy: { at: 'desc' },
      });
      expect(trace.detail).toMatchObject({ reglage: 'annuaire', reussi: false });
    });
  });

  describe('la connexion', () => {
    it('provisionne au premier login réussi, avec le rôle mappé', async () => {
      simule.ajouter('nkolo', [GROUPE_ADMINS]);
      await activer();

      await connexion('nkolo@lab.voxecho.local', 'Annuaire-2026!').expect(200);

      const cree = await prisma.user.findUniqueOrThrow({
        where: { email: 'nkolo@lab.voxecho.local' },
      });
      expect(cree.source).toBe('ad');
      expect(cree.role).toBe('ADMIN');
      // Pas de mot de passe local : lui en donner un ouvrirait une porte que
      // l'annuaire ne fermerait pas en désactivant le compte.
      expect(cree.passwordHash).toBeNull();
      expect(cree.mustChangePassword).toBe(false);
      expect(cree.externalId).toBe('guid-nkolo');

      const trace = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'USER_SET', userId: cree.id },
      });
      expect(trace.detail).toMatchObject({ acte: 'provisionnement_annuaire', role: 'ADMIN' });
    });

    it('retient le rôle le plus élevé quand plusieurs groupes correspondent', async () => {
      simule.ajouter('double', [GROUPE_AUDITEURS, GROUPE_ADMINS]);
      await activer();

      await connexion('double@lab.voxecho.local', 'Annuaire-2026!').expect(200);
      const cree = await prisma.user.findUniqueOrThrow({
        where: { email: 'double@lab.voxecho.local' },
      });
      expect(cree.role).toBe('ADMIN');
    });

    it('refuse un utilisateur qu’aucun groupe ne mappe, et consigne les groupes vus', async () => {
      simule.ajouter('stagiaire', ['CN=Domain Users,DC=lab,DC=voxecho,DC=local']);
      await activer();

      const refus = await connexion('stagiaire@lab.voxecho.local', 'Annuaire-2026!').expect(403);
      expect(JSON.stringify(refus.body)).toMatch(/Aucun groupe/);

      // Sans les groupes vus, « aucun groupe mappé » n'aide pas
      // l'administrateur à écrire la règle qui manque.
      const trace = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'LOGIN' },
        orderBy: { at: 'desc' },
      });
      expect(trace.detail).toMatchObject({
        resultat: 'annuaire_non_mappe',
        groupes: ['CN=Domain Users,DC=lab,DC=voxecho,DC=local'],
      });
      expect(await prisma.user.count({ where: { source: 'ad' } })).toBe(0);
    });

    it('refuse un mot de passe faux sans retomber sur la porte locale', async () => {
      simule.ajouter('nkolo', [GROUPE_ADMINS]);
      await activer();
      await connexion('nkolo@lab.voxecho.local', 'Mauvais-mot-de-passe-2026').expect(401);
      // Rien n'est créé sur un échec : un compte naît d'une connexion réussie.
      expect(await prisma.user.count({ where: { source: 'ad' } })).toBe(0);
    });

    it('ne fusionne jamais une adresse déjà locale', async () => {
      await prisma.user.create({
        data: {
          tenantId: banque,
          email: 'dupont@lab.voxecho.local',
          passwordHash: await hashPassword(MOT_DE_PASSE),
          role: 'AUDITOR',
        },
      });
      simule.ajouter('dupont', [GROUPE_ADMINS]);
      await activer();

      const refus = await connexion('dupont@lab.voxecho.local', 'Annuaire-2026!').expect(403);
      expect(JSON.stringify(refus.body)).toMatch(/rattacher à l’annuaire/i);

      const trace = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'LOGIN' },
        orderBy: { at: 'desc' },
      });
      expect(trace.detail).toMatchObject({ resultat: 'annuaire_conflit_local' });

      // Le compte local n'a pas bougé d'un iota.
      const local = await prisma.user.findUniqueOrThrow({
        where: { email: 'dupont@lab.voxecho.local' },
      });
      expect(local.source).toBe('local');
      expect(local.role).toBe('AUDITOR');
    });

    it('laisse un compte local entrer quand l’annuaire ne le connaît pas', async () => {
      await activer();
      await connexion('admin@a.cm', MOT_DE_PASSE).expect(200);
    });

    it('laisse un administrateur local entrer alors que l’annuaire est éteint', async () => {
      // C'est tout l'objet de l'invariant du dernier administrateur local :
      // une panne d'annuaire ne doit pas fermer la console à tout le monde.
      await activer();
      simule.injoignable = true;
      await connexion('admin@a.cm', MOT_DE_PASSE).expect(200);
    });

    it('laisse un compte local entrer quand l’annuaire connaît la même adresse', async () => {
      // Deux portes, deux mots de passe : le refus de l'une n'emporte pas
      // l'autre, sans quoi le mode hybride ne serait qu'un mode annuaire.
      await prisma.user.create({
        data: {
          tenantId: banque,
          email: 'dupont@lab.voxecho.local',
          passwordHash: await hashPassword(MOT_DE_PASSE),
          role: 'AUDITOR',
        },
      });
      simule.ajouter('dupont', [GROUPE_ADMINS]);
      await activer();

      await connexion('dupont@lab.voxecho.local', MOT_DE_PASSE).expect(200);
    });

    it('refuse les connexions d’annuaire quand il est injoignable, sans toucher aux comptes', async () => {
      simule.ajouter('nkolo', [GROUPE_ADMINS]);
      await activer();
      simule.injoignable = true;

      const refus = await connexion('nkolo@lab.voxecho.local', 'Annuaire-2026!').expect(503);
      expect(JSON.stringify(refus.body)).toMatch(/injoignable/i);

      const trace = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'LOGIN' },
        orderBy: { at: 'desc' },
      });
      expect(trace.detail).toMatchObject({ resultat: 'annuaire_injoignable' });
      // Les comptes locaux gardent leur porte : l'annuaire ne ferme pas tout.
      await connexion('admin@a.cm', MOT_DE_PASSE).expect(200);
    });

    it('ne laisse pas un compte d’annuaire entrer par la porte locale', async () => {
      simule.ajouter('nkolo', [GROUPE_ADMINS]);
      await activer();
      await connexion('nkolo@lab.voxecho.local', 'Annuaire-2026!').expect(200);

      // Annuaire éteint : le compte existe, mais il n'a pas de mot de passe
      // local et ne doit pas pouvoir en obtenir un par la bande.
      simule.injoignable = true;
      const refus = await connexion('nkolo@lab.voxecho.local', 'Annuaire-2026!').expect(503);
      expect(JSON.stringify(refus.body)).toMatch(/injoignable/i);
    });
  });

  describe('le rattachement', () => {
    it('bascule un compte local en compte d’annuaire, et lui retire son mot de passe', async () => {
      const local = await prisma.user.create({
        data: {
          tenantId: banque,
          email: 'dupont@lab.voxecho.local',
          passwordHash: await hashPassword(MOT_DE_PASSE),
          role: 'AUDITOR',
        },
      });

      const rattache = await avec(await jeton('admin@a.cm'))
        .post(`/api/users/${local.id}/rattacher-annuaire`)
        .send({})
        .expect(200);
      expect(rattache.body.source).toBe('ad');

      const relu = await prisma.user.findUniqueOrThrow({ where: { id: local.id } });
      expect(relu.passwordHash).toBeNull();

      const trace = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'USER_SET' },
        orderBy: { at: 'desc' },
      });
      expect(trace.detail).toMatchObject({
        acte: 'rattachement_annuaire',
        avant: { source: 'local' },
        apres: { source: 'ad' },
      });
    });

    it('ouvre la connexion d’annuaire une fois le rattachement fait', async () => {
      const local = await prisma.user.create({
        data: {
          tenantId: banque,
          email: 'dupont@lab.voxecho.local',
          passwordHash: await hashPassword(MOT_DE_PASSE),
          role: 'AUDITOR',
        },
      });
      simule.ajouter('dupont', [GROUPE_ADMINS]);
      await activer();

      await connexion('dupont@lab.voxecho.local', 'Annuaire-2026!').expect(403);
      await avec(await jeton('admin@a.cm'))
        .post(`/api/users/${local.id}/rattacher-annuaire`)
        .send({})
        .expect(200);
      await connexion('dupont@lab.voxecho.local', 'Annuaire-2026!').expect(200);
    });

    it('refuse de rattacher le dernier administrateur local', async () => {
      // `instance@a.cm` et `admin@a.cm` sont les deux seuls administrateurs
      // locaux : en rattacher un exige la confirmation, l'autre est refusé.
      const cible = await prisma.user.findFirstOrThrow({ where: { email: 'admin@a.cm' } });
      const instance = await jeton('instance@a.cm');

      const enDeuxTemps = await avec(instance)
        .post(`/api/users/${cible.id}/rattacher-annuaire`)
        .send({})
        .expect(400);
      expect(JSON.stringify(enDeuxTemps.body)).toMatch(/un seul administrateur local/);

      await avec(instance)
        .post(`/api/users/${cible.id}/rattacher-annuaire`)
        .send({ acceptSansContreValidation: true })
        .expect(200);

      // Il n'en reste qu'un : celui-là ne se rattache plus du tout.
      const dernier = await prisma.user.findFirstOrThrow({ where: { email: 'instance@a.cm' } });
      const refus = await avec(await jeton('instance@a.cm'))
        .post(`/api/users/${dernier.id}/rattacher-annuaire`)
        .send({ acceptSansContreValidation: true })
        .expect(400);
      // Ce n'est pas la règle du dernier admin qui parle en premier : on ne
      // modifie pas son propre compte (§9.26).
      expect(JSON.stringify(refus.body)).toMatch(/propre compte|dernier administrateur local/);
    });

    it('consigne une opération qui ne laisse qu’un administrateur local', async () => {
      const cible = await prisma.user.findFirstOrThrow({ where: { email: 'admin@a.cm' } });
      await avec(await jeton('instance@a.cm'))
        .post(`/api/users/${cible.id}/rattacher-annuaire`)
        .send({ acceptSansContreValidation: true })
        .expect(200);

      const trace = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'USER_SET' },
        orderBy: { at: 'desc' },
      });
      expect(trace.detail).toMatchObject({ contreValidation: 'sans contre-validation' });
    });
  });

  describe('la synchronisation', () => {
    it('désactive un compte sorti des groupes mappés, et le consigne', async () => {
      simule.ajouter('nkolo', [GROUPE_ADMINS]);
      await activer();
      await connexion('nkolo@lab.voxecho.local', 'Annuaire-2026!').expect(200);

      simule.ajouter('nkolo', ['CN=Domain Users,DC=lab,DC=voxecho,DC=local']);
      const bilan = await avec(await jeton('instance@a.cm'))
        .post('/api/administration/annuaire/synchroniser')
        .expect(201);
      expect(bilan.body).toMatchObject({ desactives: 1 });

      const compte = await prisma.user.findUniqueOrThrow({
        where: { email: 'nkolo@lab.voxecho.local' },
      });
      expect(compte.active).toBe(false);

      const trace = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'USER_SET', userId: compte.id },
        orderBy: { at: 'desc' },
      });
      expect(trace.detail).toMatchObject({
        acte: 'desactivation_synchronisation',
        motif: 'sorti des groupes mappés',
      });
    });

    it('désactive un compte disparu de l’annuaire', async () => {
      simule.ajouter('nkolo', [GROUPE_ADMINS]);
      await activer();
      await connexion('nkolo@lab.voxecho.local', 'Annuaire-2026!').expect(200);

      simule.comptes.delete('nkolo');
      await avec(await jeton('instance@a.cm'))
        .post('/api/administration/annuaire/synchroniser')
        .expect(201);

      const compte = await prisma.user.findUniqueOrThrow({
        where: { email: 'nkolo@lab.voxecho.local' },
      });
      expect(compte.active).toBe(false);
    });

    it('ne désactive personne quand l’annuaire est injoignable', async () => {
      simule.ajouter('nkolo', [GROUPE_ADMINS]);
      await activer();
      await connexion('nkolo@lab.voxecho.local', 'Annuaire-2026!').expect(200);
      const instance = await jeton('instance@a.cm');

      // On ne ferme pas des portes sur une panne de réseau.
      simule.injoignable = true;
      await avec(instance)
        .post('/api/administration/annuaire/synchroniser')
        .expect(500);

      const compte = await prisma.user.findUniqueOrThrow({
        where: { email: 'nkolo@lab.voxecho.local' },
      });
      expect(compte.active).toBe(true);
    });

    it('ne touche pas aux comptes locaux', async () => {
      await activer();
      await avec(await jeton('instance@a.cm'))
        .post('/api/administration/annuaire/synchroniser')
        .expect(201);

      const local = await prisma.user.findFirstOrThrow({ where: { email: 'admin@a.cm' } });
      expect(local.active).toBe(true);
    });
  });
});

/** L'échappement d'un filtre — RFC 4515. */
describe('filtre LDAP', () => {
  it('neutralise ce qui réécrirait le filtre', () => {
    // Sans échappement, `*)(objectClass=*` rendrait n'importe quel compte de
    // l'annuaire : c'est l'injection LDAP.
    expect(echapperFiltre('*)(objectClass=*')).toBe('\\2a\\29\\28objectClass=\\2a');
    expect(echapperFiltre('mbarga')).toBe('mbarga');
  });
});
