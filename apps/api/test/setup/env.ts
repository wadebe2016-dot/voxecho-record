import { testDatabaseUrl } from '../helpers/database';

/**
 * Exécuté avant l'import des modules applicatifs : `ConfigModule.forRoot`
 * lit l'environnement au chargement, la bascule vers le schéma de test doit
 * donc avoir lieu avant.
 */
process.env.DATABASE_URL = testDatabaseUrl();
process.env.NODE_ENV = 'test';
