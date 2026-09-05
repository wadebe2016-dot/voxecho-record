import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { hashPassword } from '../src/auth/password';
import { InstanceSettingsService } from '../src/settings/instance-settings.service';
import { lireHorloge } from '../src/settings/horloge';
import {
  chiffrerSecret,
  dechiffrerSecret,
  masquerSecrets,
  SECRET_MASQUE,
} from '../src/settings/secrets';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Conformite-2026-Douala!';

/**
 * Onglet Réseau et socle des réglages — CLAUDE.md §9.36.
 *
 * Trois choses s'y jouent : une section versionnée que deux administrateurs ne
 * peuvent pas s'écraser en silence, un journal qui porte l'avant/après sans
 * jamais laisser fuir un secret, et une horloge qui distingue « je n'ai pas su
 * lire » de « elle dérive ».
 */
describe('réglages d’instance : réseau', () => {
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

  const avec = (token: string) => ({
    get: (url: string) =>
      request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`),
    put: (url: string) =>
      request(app.getHttpServer()).put(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) =>
      request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${token}`),
  });

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
    banque = (await prisma.tenant.create({ data: { name: 'Banque Méridienne', slug: 'banque-a' } }))
      .id;
    for (const [email, role, instanceAdmin] of [
      ['instance@a.cm', 'ADMIN', true],
      ['admin@a.cm', 'ADMIN', false],
      ['auditeur@a.cm', 'AUDITOR', false],
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

  describe('la section', () => {
    it('rend le défaut du code quand rien n’a jamais été écrit', async () => {
      // Une table vide est une instance qui fonctionne : le seed n'y insère
      // rien, et une ligne absente ne dit pas la même chose qu'une ligne nulle.
      const reponse = await avec(await jeton('instance@a.cm'))
        .get('/api/administration/reseau')
        .expect(200);

      expect(reponse.body.reglages.fuseau).toBe('Africa/Douala');
      expect(reponse.body.version).toBe(0);
      expect(reponse.body.updatedByEmail).toBeNull();
      expect(await prisma.instanceSetting.count()).toBe(0);
    });

    it('écrit, incrémente la version et nomme l’auteur', async () => {
      const instance = await jeton('instance@a.cm');
      const ecrite = await avec(instance)
        .put('/api/administration/reseau')
        .send({ version: 0, reglages: reseau({ fuseau: 'Europe/Paris' }) })
        .expect(200);

      expect(ecrite.body.reglages.fuseau).toBe('Europe/Paris');
      expect(ecrite.body.version).toBe(1);
      expect(ecrite.body.updatedByEmail).toBe('instance@a.cm');
    });

    it('refuse une écriture fondée sur une version périmée', async () => {
      const instance = await jeton('instance@a.cm');
      await avec(instance)
        .put('/api/administration/reseau')
        .send({ version: 0, reglages: reseau({ fuseau: 'Europe/Paris' }) })
        .expect(200);

      // Le second administrateur avait lu la version 0 : accepter son écriture
      // effacerait la première sans que personne ne sache ce qui a disparu.
      const refus = await avec(instance)
        .put('/api/administration/reseau')
        .send({ version: 0, reglages: reseau({ fuseau: 'Africa/Lagos' }) })
        .expect(409);
      expect(JSON.stringify(refus.body)).toMatch(/modifié depuis son ouverture/);
    });

    it('refuse un fuseau inconnu plutôt que de casser toutes les dates', async () => {
      const refus = await avec(await jeton('instance@a.cm'))
        .put('/api/administration/reseau')
        .send({ version: 0, reglages: reseau({ fuseau: 'Afrique/Douala' }) })
        .expect(400);
      expect(JSON.stringify(refus.body)).toMatch(/Fuseau horaire inconnu/);
    });

    it('n’applique pas ce que rien n’applique', async () => {
      // La saisie NTP et DNS est conservée pour affichage ; prétendre qu'elle
      // est appliquée ferait croire à un réglage pris en compte.
      const ecrite = await avec(await jeton('instance@a.cm'))
        .put('/api/administration/reseau')
        .send({
          version: 0,
          reglages: {
            ...reseau({}),
            ntp: { serveurs: ['ntp.camtel.cm'], applique: true },
            dns: {
              primaire: '10.0.0.1',
              secondaire: null,
              domaineRecherche: 'banque.local',
              applique: true,
            },
          },
        })
        .expect(200);

      expect(ecrite.body.reglages.ntp).toMatchObject({
        serveurs: ['ntp.camtel.cm'],
        applique: false,
      });
      expect(ecrite.body.reglages.dns.applique).toBe(false);
    });
  });

  describe('les relais de confiance', () => {
    it('dit que l’environnement l’emporte, et lequel s’applique', async () => {
      // TRUSTED_PROXIES est vide dans l'environnement de test : c'est donc la
      // base qui s'applique, et la réponse le dit.
      const instance = await jeton('instance@a.cm');
      const ecrite = await avec(instance)
        .put('/api/administration/reseau')
        .send({ version: 0, reglages: reseau({ proxys: { cidr: ['172.20.0.0/16'] } }) })
        .expect(200);

      expect(ecrite.body.proxysEnVigueur).toEqual({
        valeurs: ['172.20.0.0/16'],
        source: 'base',
      });
    });

    it('refuse une valeur qui n’est pas une adresse', async () => {
      await avec(await jeton('instance@a.cm'))
        .put('/api/administration/reseau')
        .send({ version: 0, reglages: reseau({ proxys: { cidr: ['nginx'] } }) })
        .expect(400);
    });
  });

  describe('le journal', () => {
    it('porte l’avant et l’après du réglage', async () => {
      const instance = await jeton('instance@a.cm');
      await avec(instance)
        .put('/api/administration/reseau')
        .send({ version: 0, reglages: reseau({ fuseau: 'Europe/Paris' }) })
        .expect(200);

      const trace = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'SETTINGS_SET' } });
      // Un réglage d'instance n'appartient à aucun locataire : c'est le
      // deuxième cas de `tenantId` nul, après les quarantaines du §9.2.
      expect(trace.tenantId).toBeNull();
      expect(trace.detail).toMatchObject({
        reglage: 'reseau',
        versionAvant: 0,
        versionApres: 1,
        avant: { fuseau: 'Africa/Douala' },
        apres: { fuseau: 'Europe/Paris' },
      });
    });

    it('inscrit un test qui échoue comme un test qui réussit', async () => {
      const instance = await jeton('instance@a.cm');
      await avec(instance)
        .put('/api/administration/reseau')
        .send({ version: 0, reglages: { ...reseau({}), ntp: { serveurs: ['machin.invalid'] } } })
        .expect(200);

      const resultats = await avec(instance)
        .post('/api/administration/reseau/test/ntp')
        .expect(201);
      expect(resultats.body[0]).toMatchObject({ serveur: 'machin.invalid', joignable: false });

      // Un test qui ne laisserait trace qu'en réussissant ne servirait qu'à se
      // rassurer (§9.36).
      const trace = await prisma.auditEvent.findFirstOrThrow({
        where: { action: 'SETTINGS_TEST' },
      });
      expect(trace.detail).toMatchObject({ reglage: 'reseau.ntp', reussi: false });
    });
  });

  describe('l’habilitation', () => {
    it('refuse l’onglet à un ADMIN qui n’administre pas l’instance', async () => {
      await avec(await jeton('admin@a.cm'))
        .get('/api/administration/reseau')
        .expect(403);
      await avec(await jeton('auditeur@a.cm'))
        .get('/api/administration/reseau')
        .expect(403);
    });

    it('ouvre l’état de l’horloge aux trois rôles', async () => {
      // Le bandeau d'horodatage non fiable s'affiche en tête de toute la
      // console : un auditeur qui relève une empreinte doit savoir que l'heure
      // inscrite à côté n'est peut-être pas défendable.
      const reponse = await avec(await jeton('auditeur@a.cm'))
        .get('/api/administration/reseau/horloge')
        .expect(200);
      expect(reponse.body.statut).toBeDefined();
    });

    it('porte le fuseau d’instance au profil', async () => {
      await avec(await jeton('instance@a.cm'))
        .put('/api/administration/reseau')
        .send({ version: 0, reglages: reseau({ fuseau: 'Europe/Paris' }) })
        .expect(200);

      const profil = await avec(await jeton('auditeur@a.cm'))
        .get('/api/auth/me')
        .expect(200);
      expect(profil.body.fuseau).toBe('Europe/Paris');
    });
  });
});

/**
 * L'horloge se lit dans un instantané — CLAUDE.md §9.36. Ces cas ne passent pas
 * par l'api : c'est la lecture du relevé qu'on éprouve, pas la route.
 */
describe('état de l’horloge', () => {
  let dossier: string;
  const chemin = () => join(dossier, 'horloge.csv');

  /**
   * Un relevé au format `chronyc -c tracking`, quatorze champs.
   *
   * Les colonnes par défaut décrivent une horloge saine, synchronisée à
   * l'instant du relevé : chaque cas ne remplace donc que ce qu'il éprouve.
   */
  async function releve(champs: Partial<Record<number, string>>, ageMs = 0): Promise<void> {
    const colonnes = [
      'C0FFEE01',
      '196.1.2.3',
      '2',
      String(Date.now() / 1000),
      '0.000123',
      '-0.000001',
      '0.000004',
      '-6.360',
      '-0.000',
      '0.262',
      '0.000250',
      '0.000321',
      '32.2',
      'Normal',
    ];
    for (const [index, valeur] of Object.entries(champs))
      colonnes[Number(index)] = valeur as string;
    await writeFile(chemin(), `${colonnes.join(',')}\n`);
    if (ageMs > 0) {
      const quand = new Date(Date.now() - ageMs);
      await utimes(chemin(), quand, quand);
    }
  }

  beforeAll(async () => {
    dossier = await mkdtemp(join(tmpdir(), 'voxecho-horloge-'));
  });

  afterAll(async () => {
    await rm(dossier, { recursive: true, force: true });
  });

  it('dit « indisponible » quand le relevé manque, jamais « non synchronisé »', async () => {
    // Les deux ne disent pas la même chose : l'un qu'on n'a pas su lire
    // l'horloge, l'autre qu'on l'a lue et qu'elle ne suit plus. Seul le second
    // met en cause la valeur probante des horodatages.
    const etat = await lireHorloge(join(dossier, 'absent.csv'));
    expect(etat.statut).toBe('indisponible');
    expect(etat.message).toMatch(/Aucun relevé/);
  });

  it('dit « indisponible » quand le relevé est périmé', async () => {
    await releve({}, 10 * 60 * 1000);
    const etat = await lireHorloge(chemin());
    expect(etat.statut).toBe('indisponible');
    expect(etat.message).toMatch(/ne décrit plus l’heure qu’il est/);
  });

  it('lit une horloge synchronisée et son décalage', async () => {
    await releve({ 4: '0.0000451' });
    const etat = await lireHorloge(chemin());
    expect(etat.statut).toBe('synchronise');
    expect(etat.decalageMs).toBe(0);
    expect(etat.source).toBe('196.1.2.3');
    expect(etat.stratum).toBe(2);
  });

  it('avertit au-delà d’une demi-seconde de dérive', async () => {
    await releve({ 4: '0.75' });
    const etat = await lireHorloge(chemin());
    expect(etat.statut).toBe('derive');
    expect(etat.decalageMs).toBe(750);
  });

  it('déclare non synchronisée une horloge qui dérive de plus de cinq secondes', async () => {
    await releve({ 4: '-7.2' });
    const etat = await lireHorloge(chemin());
    expect(etat.statut).toBe('non_synchronise');
    // Le décalage est une distance : son signe ne dit rien de plus.
    expect(etat.decalageMs).toBe(7200);
  });

  it('déclare non synchronisée une horloge sans source', async () => {
    // `7F7F0101` est l'adresse dont chrony se sert quand il n'est synchronisé
    // sur rien : la rendre telle quelle laisserait croire à une référence.
    await releve({ 1: '7F7F0101' });
    const etat = await lireHorloge(chemin());
    expect(etat.statut).toBe('non_synchronise');
    expect(etat.source).toBeNull();
    expect(etat.message).toMatch(/synchronisé sur aucune source/);
  });

  it('déclare non synchronisée une horloge sans mise à jour depuis un jour', async () => {
    await releve({ 3: String(Date.now() / 1000 - 30 * 3600) });
    const etat = await lireHorloge(chemin());
    expect(etat.statut).toBe('non_synchronise');
    expect(etat.message).toMatch(/vingt-quatre heures/);
  });

  it('déclare non synchronisée une horloge que chrony dit telle', async () => {
    // « Not synchronised » est ce que chrony affirme : cela l'emporte sur ce
    // qu'on déduirait d'un stratum ou d'un identifiant de référence.
    await releve({ 13: 'Not synchronised' });
    const etat = await lireHorloge(chemin());
    expect(etat.statut).toBe('non_synchronise');
    expect(etat.source).toBeNull();
  });

  it('lit la ligne réelle de l’instance d’évaluation', async () => {
    // Relevé pris sur voxecho-demo. Le quatrième champ est une **date** en
    // secondes epoch, non un âge : le lire comme un âge donnait une dernière
    // synchronisation en 1970 et un faux « aucune synchronisation depuis plus
    // de vingt-quatre heures » sur une horloge parfaitement à l'heure.
    const ligne =
      'A9FEA97B,169.254.169.123,4,1788638747.313777128,0.000001173,-0.000001217,' +
      '0.000004896,-6.360,-0.000,0.262,0.000250475,0.000321630,32.2,Normal';
    await writeFile(chemin(), `${ligne}\n`);

    // La date de référence est celle du relevé ; on se place le même jour, sans
    // quoi l'horloge serait à bon droit déclarée hors délai.
    const etat = await lireHorloge(chemin(), new Date('2026-09-05T20:10:00Z'));

    expect(etat.statut).toBe('synchronise');
    expect(etat.derniereSynchro).toBe('2026-09-05T20:05:47.313Z');
    expect(etat.source).toBe('169.254.169.123');
    expect(etat.stratum).toBe(4);
    // Le décalage vient de l'écart système — cinquième champ, 1,173 µs — et
    // non d'un défaut : il s'affiche « 0 ms » parce qu'il vaut réellement zéro
    // à la milliseconde près.
    expect(etat.decalageMs).toBe(0);
    expect(etat.message).toMatch(/Synchronisée sur 169\.254\.169\.123/);
  });

  it('tire le décalage de l’écart système, et non d’un autre champ', async () => {
    // Le dernier écart et l'écart quadratique moyen sont volontairement
    // grossiers : seul le cinquième champ doit compter.
    await releve({ 4: '0.0032', 5: '-9.999', 6: '7.777' });
    const etat = await lireHorloge(chemin());
    expect(etat.statut).toBe('synchronise');
    expect(etat.decalageMs).toBe(3);
  });

  it('déclare non synchronisée une horloge qui n’a jamais eu de référence', async () => {
    // chrony écrit une date à l'epoch tant qu'il n'a rien à quoi se référer.
    await releve({ 0: '00000000', 2: '0', 3: '0', 13: 'Not synchronised' });
    const etat = await lireHorloge(chemin());
    expect(etat.statut).toBe('non_synchronise');
    expect(etat.derniereSynchro).toBeNull();
  });

  it('dit « indisponible » sur un relevé tronqué', async () => {
    // Une ligne trop courte n'est pas un relevé : elle donnerait des champs
    // pris les uns pour les autres, donc un état inventé.
    await writeFile(chemin(), 'C0FFEE01,196.1.2.3,2\n');
    const etat = await lireHorloge(chemin());
    expect(etat.statut).toBe('indisponible');
    expect(etat.message).toMatch(/illisible/);
  });

  it('dit « indisponible » sur un relevé qui n’a pas la forme attendue', async () => {
    await writeFile(chemin(), 'ceci n’est pas un relevé\n');
    const etat = await lireHorloge(chemin());
    expect(etat.statut).toBe('indisponible');
    expect(etat.message).toMatch(/illisible/);
  });
});

/** Secrets de réglage — CLAUDE.md §9.36. */
describe('secrets de réglage', () => {
  const cleMaitre = Buffer.alloc(32, 7);

  it('chiffre et rend le clair', () => {
    const secret = chiffrerSecret(cleMaitre, 'mot-de-passe-de-liaison');
    expect(secret.chiffre).not.toContain('liaison');
    expect(dechiffrerSecret(cleMaitre, secret)).toBe('mot-de-passe-de-liaison');
  });

  it('ne s’ouvre pas avec une autre clé maître', () => {
    const secret = chiffrerSecret(cleMaitre, 'mot-de-passe-de-liaison');
    expect(() => dechiffrerSecret(Buffer.alloc(32, 8), secret)).toThrow();
  });

  it('tire un conteneur différent à chaque écriture du même secret', () => {
    const a = chiffrerSecret(cleMaitre, 'identique');
    const b = chiffrerSecret(cleMaitre, 'identique');
    expect(a.chiffre).not.toBe(b.chiffre);
  });

  it('masque les secrets en profondeur, et rien d’autre', () => {
    const masque = masquerSecrets({
      url: 'ldaps://dc01',
      bind: { dn: 'CN=svc', motDePasse: chiffrerSecret(cleMaitre, 'secret') },
      liste: [chiffrerSecret(cleMaitre, 'autre')],
    });
    expect(masque).toEqual({
      url: 'ldaps://dc01',
      bind: { dn: 'CN=svc', motDePasse: SECRET_MASQUE },
      liste: [SECRET_MASQUE],
    });
  });
});

/** Une saisie de section réseau, complète et modifiable au cas par cas. */
function reseau(modifications: Record<string, unknown>): Record<string, unknown> {
  return {
    fuseau: 'Africa/Douala',
    ntp: { serveurs: [] },
    dns: { primaire: null, secondaire: null, domaineRecherche: null },
    proxys: { cidr: [] },
    ...modifications,
  };
}
