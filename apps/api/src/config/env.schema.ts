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

  INGEST_DIR: z.string().min(1).default('./data/ingest'),
  STORAGE_DIR: z.string().min(1).default('./data/storage'),
  QUARANTINE_DIR: z.string().min(1).default('./data/quarantine'),

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
  return env;
}

/** Origines autorisées pour le portail, découpées et nettoyées. */
export function corsOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
