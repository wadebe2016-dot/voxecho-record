import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PrismaClient } from '@prisma/client';

/**
 * Les tests d'intégration travaillent dans des schémas PostgreSQL dédiés de
 * la même base : on ne touche jamais aux données de développement, et aucune
 * création de base n'est nécessaire en CI.
 *
 * **Un schéma par worker Jest.** Les suites tournent en parallèle et
 * `resetTestData` vide les tables entre les cas ; sur un schéma partagé, deux
 * workers se détruisent mutuellement leurs données. Le symptôme — une
 * contrainte d'unicité sur un nom de locataire, ou un enregistrement
 * introuvable — n'apparaît qu'au-delà d'un worker, donc jamais sur une
 * machine à deux cœurs et systématiquement sur un runner qui en a quatre.
 */
const RACINE = join(__dirname, '..', '..', '..', '..');

loadEnv({ path: join(RACINE, '.env') });

/** Schéma du worker courant. Hors worker (setup global), c'est `test_1`. */
export function testSchema(): string {
  const worker = (process.env.JEST_WORKER_ID ?? '1').replace(/\D/g, '');
  return `test_${worker || '1'}`;
}

export function testDatabaseUrl(schema: string = testSchema()): string {
  const brut = process.env.DATABASE_URL;
  if (!brut) {
    throw new Error(
      'DATABASE_URL absente : lancer `docker compose up -d db` et copier .env.example en .env',
    );
  }
  const url = new URL(brut);
  url.searchParams.set('schema', schema);
  return url.toString();
}

/** Applique les migrations à un schéma de test (appelé par le setup global). */
export function migrateTestSchema(schema: string): void {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: join(__dirname, '..', '..'),
    env: { ...process.env, DATABASE_URL: testDatabaseUrl(schema) },
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
  const schema = testSchema();
  await prisma.$executeRawUnsafe(`ALTER TABLE ${schema}.audit_events DISABLE TRIGGER USER`);
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM ${schema}.audit_events`);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE ${schema}.audit_events ENABLE TRIGGER USER`);
  }
  // Les politiques publiées sont immuables en base (§9.23), comme le journal :
  // seule une bascule explicite du garde-fou, réservée aux tests, permet de
  // remettre un schéma de test à zéro.
  await prisma.$executeRawUnsafe(
    `ALTER TABLE ${schema}.recording_policy_versions DISABLE TRIGGER USER`,
  );
  try {
    await prisma.recordingPolicyVersion.deleteMany();
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE ${schema}.recording_policy_versions ENABLE TRIGGER USER`,
    );
  }

  // Les rapports de purge retiennent les enregistrements qu'ils énumèrent
  // (`onDelete: Restrict`) : un appel cité dans un rapport ne s'efface pas.
  await prisma.purgeRunItem.deleteMany();
  await prisma.purgeRun.deleteMany();
  await prisma.legalHold.deleteMany();
  await prisma.retentionPolicy.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.recording.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
}
