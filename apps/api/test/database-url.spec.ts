import { PrismaClient } from '@prisma/client';
import {
  appliquerDatabaseUrl,
  construireDatabaseUrl,
  databaseUrlDepuisEnv,
} from '../src/config/database-url';
import { createTestPrisma, testDatabaseUrl } from './helpers/database';

/**
 * URL de connexion PostgreSQL — CLAUDE.md §9.19.
 *
 * Le compose assemblait l'URL par concaténation. Un mot de passe tiré au
 * hasard contient tôt ou tard `/`, `+` ou `=` : le premier `/` referme la
 * partie autorité, et Prisma refuse de démarrer sur un « invalid port number »
 * qui ne dit rien du vrai problème. L'api redémarrait en boucle sur l'instance
 * de démonstration pendant qu'on cherchait du côté du port.
 *
 * Le cas d'intégration ci-dessous crée un vrai rôle PostgreSQL doté d'un mot
 * de passe hostile et s'y connecte : c'est la seule façon de prouver que
 * l'encodage est le bon, plutôt que de vérifier une chaîne contre une autre
 * chaîne écrite par la même main.
 */
describe('URL de connexion', () => {
  describe('construction', () => {
    it('encode ce qui casserait l’URL', () => {
      const url = construireDatabaseUrl({
        user: 'voxecho',
        password: 'a/b+c=d@e:f?g#h',
        host: 'db',
        port: 5432,
        database: 'voxecho',
      });

      // Aucun caractère gênant ne subsiste hors encodage, et le port reste
      // lisible : c'est lui que Prisma n'arrivait plus à lire. L'url porte en
      // outre le fuseau imposé à la session (§9.27).
      expect(url).toBe(
        'postgresql://voxecho:a%2Fb%2Bc%3Dd%40e%3Af%3Fg%23h@db:5432/voxecho' +
          '?schema=public&options=-c%20timezone%3DUTC',
      );
      expect(new URL(url).port).toBe('5432');
      expect(decodeURIComponent(new URL(url).password)).toBe('a/b+c=d@e:f?g#h');
    });

    it('respecte une DATABASE_URL fournie, et ne construit qu’à défaut', () => {
      // Une url fournie est respectée, au fuseau près : c'est le seul réglage
      // que le produit impose, parce qu'il en va de la justesse du journal.
      expect(databaseUrlDepuisEnv({ DATABASE_URL: 'postgresql://donnee/entiere' })).toBe(
        'postgresql://donnee/entiere?options=-c%20timezone%3DUTC',
      );

      const construite = databaseUrlDepuisEnv({
        POSTGRES_USER: 'voxecho',
        POSTGRES_PASSWORD: 'mot/de+passe',
        POSTGRES_DB: 'voxecho',
      });
      expect(construite).toContain('mot%2Fde%2Bpasse');
      // Hôte et port par défaut : ceux du compose.
      expect(construite).toContain('@db:5432/voxecho');

      // Sans de quoi construire, on ne devine pas : le point d'entrée doit
      // pouvoir le dire clairement plutôt que de fabriquer une URL fausse.
      expect(databaseUrlDepuisEnv({})).toBeNull();
    });

    it('pose l’URL dans l’environnement sans écraser celle qui existe', () => {
      const env: NodeJS.ProcessEnv = {
        POSTGRES_USER: 'voxecho',
        POSTGRES_PASSWORD: 'x/y',
        POSTGRES_DB: 'voxecho',
      };
      appliquerDatabaseUrl(env);
      expect(env.DATABASE_URL).toContain('x%2Fy');

      const dejaFournie: NodeJS.ProcessEnv = { DATABASE_URL: 'postgresql://intacte' };
      appliquerDatabaseUrl(dejaFournie);
      expect(dejaFournie.DATABASE_URL).toBe('postgresql://intacte?options=-c%20timezone%3DUTC');
    });
  });

  describe('connexion réelle', () => {
    /** Ce qui a cassé la démonstration : base64 brut, avec `/` et `+`. */
    const MOT_DE_PASSE = 'aB3/xY9+zQ==';
    const ROLE = 'voxecho_essai_url';
    let administration: PrismaClient;

    beforeAll(async () => {
      administration = createTestPrisma();
      await administration.$connect();
      await administration.$executeRawUnsafe(`DROP ROLE IF EXISTS ${ROLE}`);
      await administration.$executeRawUnsafe(
        `CREATE ROLE ${ROLE} LOGIN PASSWORD '${MOT_DE_PASSE}'`,
      );
    });

    afterAll(async () => {
      await administration.$executeRawUnsafe(`DROP ROLE IF EXISTS ${ROLE}`);
      await administration.$disconnect();
    });

    it('se connecte avec un mot de passe qui contient / + =', async () => {
      const modele = new URL(testDatabaseUrl());
      const url = construireDatabaseUrl({
        user: ROLE,
        password: MOT_DE_PASSE,
        host: modele.hostname,
        port: modele.port || 5432,
        database: modele.pathname.replace(/^\//, ''),
        schema: modele.searchParams.get('schema') ?? 'public',
      });

      const client = new PrismaClient({ datasources: { db: { url } } });
      try {
        await expect(client.$queryRawUnsafe('SELECT 1 as un')).resolves.toEqual([{ un: 1 }]);
      } finally {
        await client.$disconnect();
      }
    });

    it('échoue comme avant si l’URL est concaténée sans encodage', async () => {
      // La preuve que le défaut était bien là : la même connexion, assemblée
      // comme le faisait le compose, ne s'établit pas.
      const modele = new URL(testDatabaseUrl());
      const brute = `postgresql://${ROLE}:${MOT_DE_PASSE}@${modele.hostname}:${modele.port || 5432}/${modele.pathname.replace(/^\//, '')}`;

      const client = new PrismaClient({ datasources: { db: { url: brute } } });
      await expect(client.$queryRawUnsafe('SELECT 1')).rejects.toThrow();
      await client.$disconnect().catch(() => undefined);
    });
  });
});
