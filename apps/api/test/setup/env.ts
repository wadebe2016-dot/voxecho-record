import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDatabaseUrl } from '../helpers/database';

/**
 * Exécuté avant l'import des modules applicatifs : `ConfigModule.forRoot`
 * lit l'environnement au chargement du module, la bascule doit donc avoir
 * lieu ici et pas dans un `beforeAll`.
 */
process.env.DATABASE_URL = testDatabaseUrl();
process.env.NODE_ENV = 'test';

// Les tests déclenchent le balayage d'ingestion eux-mêmes : un balayage
// périodique en fond viendrait ramasser leurs dépôts à contretemps.
process.env.INGEST_POLL_ENABLED = 'false';

/**
 * Les suites enchaînent délibérément des échecs de connexion — c'est ainsi
 * que se teste un verrouillage de compte. Le seuil par adresse est donc levé
 * ici, sans quoi une suite bloquerait la suivante : elles partagent la même
 * adresse d'origine. La limitation elle-même est éprouvée dans sa propre
 * suite, sur une application montée avec un réglage serré (§9.16).
 */
process.env.AUTH_RATE_MAX = '10000';

/**
 * Répertoires de travail propres à chaque fichier de test : l'ingestion
 * déplace de vrais fichiers, et deux suites qui partageraient un même
 * INGEST_DIR se voleraient leurs dépôts.
 */
const racine = mkdtempSync(join(tmpdir(), 'voxecho-test-'));
process.env.INGEST_DIR = join(racine, 'ingest');
process.env.STORAGE_DIR = join(racine, 'storage');
process.env.QUARANTINE_DIR = join(racine, 'quarantine');
