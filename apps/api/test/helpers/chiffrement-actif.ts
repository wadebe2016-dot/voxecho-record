import { randomBytes } from 'node:crypto';
import { TAILLE_CLE } from '../../src/storage/coffre';

/**
 * Active le chiffrement au repos pour la suite qui importe ce module.
 *
 * **À importer avant `AppModule`.** `ConfigModule.forRoot()` lit et valide
 * l'environnement au moment où le module de configuration est *importé*, pas
 * quand l'application est instanciée : une bascule posée dans un `beforeAll`
 * arriverait après la photographie et resterait sans effet. Les imports d'un
 * module s'exécutant dans l'ordre du source, un import à effet de bord placé
 * en tête suffit.
 */
export const CLE_MAITRE_TEST = randomBytes(TAILLE_CLE).toString('base64');
export const REFERENCE_CLE_TEST = 'k-test';

process.env.STORAGE_ENCRYPTION_ENABLED = 'true';
process.env.STORAGE_MASTER_KEY = CLE_MAITRE_TEST;
process.env.STORAGE_KEY_REF = REFERENCE_CLE_TEST;
