import { z } from 'zod';

/**
 * Validation de l'environnement au démarrage. Un secret manquant ou laissé à
 * sa valeur d'exemple doit empêcher le démarrage : mieux vaut ne pas démarrer
 * qu'exploiter un enregistreur de conformité mal configuré.
 */

const duration = z.string().regex(/^\d+[smhd]$/, 'durée attendue, ex. 15m ou 7d');

/** `z.coerce.boolean()` accepte « false » comme vrai : on lit le mot. */
const booleen = z.enum(['true', 'false']).transform((value) => value === 'true');

const secret = z
  .string()
  .min(32, 'secret trop court (32 caractères minimum)')
  .refine((value) => !value.startsWith('changeme'), 'secret d’exemple non remplacé');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  TZ: z.string().default('Africa/Douala'),

  DATABASE_URL: z.string().url(),

  API_PORT: z.coerce.number().int().positive().max(65535).default(3000),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),

  JWT_ACCESS_SECRET: secret,
  JWT_REFRESH_SECRET: secret,
  JWT_ACCESS_TTL: duration.default('15m'),
  JWT_REFRESH_TTL: duration.default('7d'),
  AUTH_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(5),
  AUTH_LOCK_DURATION_MIN: z.coerce.number().int().min(1).max(1440).default(15),

  // Limitation des tentatives par adresse (CLAUDE.md §9.16). Elle ne
  // remplace pas le verrouillage de compte ci-dessus : l'un protège un
  // compte nommé, l'autre freine le balayage de comptes.
  AUTH_RATE_MAX: z.coerce.number().int().min(1).max(10_000).default(10),
  AUTH_RATE_WINDOW_SEC: z.coerce.number().int().min(1).max(3600).default(60),
  /** Nombre d'adresses suivies au plus : un balayage distribué ne doit pas
   *  faire enfler la mémoire de l'api. Les plus anciennes sont oubliées. */
  AUTH_RATE_MAX_ADRESSES: z.coerce.number().int().min(100).max(1_000_000).default(10_000),

  /**
   * Proxys dont on accepte l'en-tête `X-Forwarded-For` — adresses ou CIDR
   * séparés par des virgules, ou `loopback`. **Vide par défaut** : sans
   * cela, n'importe qui inscrirait l'adresse de son choix dans un journal
   * d'audit qu'on ne peut pas corriger (§9.16).
   */
  TRUSTED_PROXIES: z.string().default(''),

  /**
   * L'api est-elle servie derrière une terminaison TLS ? Commande le seul
   * en-tête qu'il serait malhonnête d'émettre en clair : HSTS promet au
   * navigateur que le site est joignable en HTTPS.
   */
  API_BEHIND_TLS: booleen.default('false'),

  // Billet d'écoute : court, limité à un enregistrement et à son demandeur.
  // Sa durée borne aussi ce que dure « une écoute » au journal d'audit — le
  // lecteur qui redemande un billet ouvre une nouvelle consultation, tracée.
  LISTEN_TICKET_TTL: duration.default('30m'),

  // Plancher de conservation de l'instance. L'api refuse une politique plus
  // courte sans motif écrit : « jamais moins sans décision explicite »
  // suppose que la décision existe quelque part de lisible (CLAUDE.md §9.6).
  RETENTION_MIN_DAYS: z.coerce.number().int().min(1).max(7300).default(730),

  // Chiffrement au repos des pièces audio (CLAUDE.md §8, §9.13).
  // La clé maître vit hors du dépôt : montée en secret, en variable
  // d'environnement, ou fournie par un coffre. Elle n'a pas de valeur par
  // défaut — un chiffrement à clé connue de tous ne chiffre rien.
  STORAGE_ENCRYPTION_ENABLED: booleen.default('false'),
  STORAGE_MASTER_KEY: z.string().default(''),
  /** Référence de la clé en service, inscrite sur chaque pièce scellée. */
  STORAGE_KEY_REF: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,31}$/, 'référence de clé : minuscules, chiffres, . _ -')
    .default('k1'),

  INGEST_DIR: z.string().min(1).default('./data/ingest'),
  STORAGE_DIR: z.string().min(1).default('./data/storage'),
  QUARANTINE_DIR: z.string().min(1).default('./data/quarantine'),
  // Sauvegardes (CLAUDE.md §9.14). Une prise par sous-répertoire daté ;
  // les pièces audio n'y sont pas recopiées, seulement inventoriées.
  BACKUP_DIR: z.string().min(1).default('./data/backups'),

  // Balayage périodique plutôt qu'inotify : un répertoire d'ingestion est
  // souvent un volume monté ou un partage réseau, où les événements du
  // système de fichiers se perdent. Un balayage rattrape aussi ce qui a été
  // déposé pendant que l'api était arrêtée.
  INGEST_POLL_ENABLED: booleen.default('true'),
  INGEST_POLL_MS: z.coerce.number().int().min(250).max(600_000).default(5_000),
  // Un wav sans son json passé ce délai n'est plus un dépôt en cours : il
  // part en quarantaine plutôt que de rester indéfiniment en attente.
  INGEST_ORPHAN_MIN: z.coerce.number().int().min(1).max(1440).default(10),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Valide l'environnement. Lève avec la liste complète des manques : on ne
 * corrige pas une variable à la fois au redémarrage.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')} : ${issue.message}`)
      .join('\n');
    throw new Error(`Configuration invalide (voir .env.example) :\n${details}`);
  }
  const env = result.data;
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    throw new Error(
      'Configuration invalide : JWT_ACCESS_SECRET et JWT_REFRESH_SECRET doivent différer.',
    );
  }
  if (env.STORAGE_ENCRYPTION_ENABLED) {
    // Mieux vaut ne pas démarrer que ranger des preuves derrière une clé
    // absente ou trop courte, en croyant les avoir chiffrées.
    const cle = Buffer.from(env.STORAGE_MASTER_KEY, 'base64');
    if (cle.length !== 32) {
      throw new Error(
        'Configuration invalide : STORAGE_ENCRYPTION_ENABLED exige une STORAGE_MASTER_KEY de 32 octets en base64 (openssl rand -base64 32).',
      );
    }
  }
  return env;
}

/** Origines autorisées pour le portail, découpées et nettoyées. */
export function corsOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
