import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';

/**
 * Les tests d'intégration travaillent dans un schéma PostgreSQL dédié
 * (`test`) de la même base : on ne touche jamais aux données de développement,
 * et aucune création de base n'est nécessaire en CI.
 */
const RACINE = join(__dirname, '..', '..', '..', '..');
const SCHEMA_DE_TEST = 'test';

loadEnv({ path: join(RACINE, '.env') });

export function testDatabaseUrl(): string {
  const brut = process.env.DATABASE_URL;
  if (!brut) {
    throw new Error(
      'DATABASE_URL absente : lancer `docker compose up -d db` et copier .env.example en .env',
    );
  }
  const url = new URL(brut);
  url.searchParams.set('schema', SCHEMA_DE_TEST);
  return url.toString();
}

/** Applique les migrations au schéma de test (appelé une fois avant la suite). */
export function migrateTestSchema(): void {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: join(__dirname, '..', '..'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: 'pipe',
  });
}

export function createTestPrisma(): PrismaClient {
  return new PrismaClient({ datasources: { db: { url: testDatabaseUrl() } } });
}

/**
 * Vide les tables métier entre les suites. `audit_events` est append-only :
 * son contenu ne peut être effacé que par une bascule explicite du garde-fou,
 * ce que fait cette fonction réservée aux tests.
 */
export async function resetTestData(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe('ALTER TABLE test.audit_events DISABLE TRIGGER USER');
  try {
    await prisma.$executeRawUnsafe('DELETE FROM test.audit_events');
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE test.audit_events ENABLE TRIGGER USER');
  }
  await prisma.legalHold.deleteMany();
  await prisma.retentionPolicy.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.recording.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
}
