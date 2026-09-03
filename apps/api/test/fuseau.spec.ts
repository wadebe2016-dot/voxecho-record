import { PrismaClient } from '@prisma/client';
import { avecFuseauUtc, construireDatabaseUrl } from '../src/config/database-url';
import { createTestPrisma, testDatabaseUrl } from './helpers/database';

/**
 * Fuseau de la base — CLAUDE.md §9.27.
 *
 * Les colonnes d'horodatage sont des `timestamp` sans fuseau, et celles qui
 * portent `DEFAULT CURRENT_TIMESTAMP` prennent l'heure **du fuseau de la
 * session**. Sur une base réglée sur Africa/Douala, `audit_events.at` était
 * écrit avec une heure d'avance, relu comme de l'UTC, puis affiché avec une
 * heure de plus encore. Un journal append-only faux, que rien ne signalait.
 */
describe('fuseau de la base', () => {
  describe('url de connexion', () => {
    it('impose UTC à la session', () => {
      const url = new URL(
        construireDatabaseUrl({
          user: 'voxecho',
          password: 'x',
          host: 'db',
          port: 5432,
          database: 'voxecho',
        }),
      );
      expect(url.searchParams.get('options')).toBe('-c timezone=UTC');
    });

    it('respecte les options que l’exploitant a lui-même posées', () => {
      // On ne contredit pas un réglage explicite dans son dos ; le contrôle au
      // démarrage refusera de toute façon une session qui n'est pas en UTC.
      const fournie = 'postgresql://u:p@h:5432/db?options=-c%20statement_timeout%3D5000';
      expect(avecFuseauUtc(fournie)).toBe(fournie);
    });
  });

  describe('ce que la base écrit', () => {
    it('horodate en UTC, quel que soit le réglage du serveur', async () => {
      const prisma = createTestPrisma();
      try {
        const [session] = await prisma.$queryRawUnsafe<{ fuseau: string }[]>(
          "SELECT current_setting('TimeZone') AS fuseau",
        );
        expect(session?.fuseau).toBe('UTC');

        // Le contrôle qui compte : ce que `DEFAULT CURRENT_TIMESTAMP` écrirait
        // doit coïncider avec l'heure de l'application, à la seconde près.
        const avant = Date.now();
        const [ligne] = await prisma.$queryRawUnsafe<{ ecrit: Date }[]>(
          'SELECT CURRENT_TIMESTAMP::timestamp(3) AS ecrit',
        );
        const ecart = Math.abs((ligne?.ecrit.getTime() ?? 0) - avant);
        expect(ecart).toBeLessThan(5_000);
      } finally {
        await prisma.$disconnect();
      }
    });

    it('décalerait d’une heure sans ce forçage — la preuve du défaut', async () => {
      // Reproduction du bug : la même base, sans imposer le fuseau. Ce test
      // n'a de sens que si le serveur n'est pas déjà en UTC ; il se contente
      // alors de constater que l'écart existe.
      const sansForcage = testDatabaseUrl().replace(/&?options=[^&]*/, '');
      const prisma = new PrismaClient({ datasources: { db: { url: sansForcage } } });
      try {
        const [session] = await prisma.$queryRawUnsafe<{ fuseau: string }[]>(
          "SELECT current_setting('TimeZone') AS fuseau",
        );
        const [ligne] = await prisma.$queryRawUnsafe<{ ecrit: Date }[]>(
          'SELECT CURRENT_TIMESTAMP::timestamp(3) AS ecrit',
        );
        const ecart = Math.abs((ligne?.ecrit.getTime() ?? 0) - Date.now());

        if (session?.fuseau === 'UTC') {
          // Serveur déjà en UTC : rien à constater, mais on l'affirme.
          expect(ecart).toBeLessThan(5_000);
        } else {
          // Serveur en fuseau local : l'écart est exactement le décalage, et
          // c'est lui qui faussait le journal.
          expect(ecart).toBeGreaterThan(30 * 60_000);
        }
      } finally {
        await prisma.$disconnect();
      }
    });
  });
});
