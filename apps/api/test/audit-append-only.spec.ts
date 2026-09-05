import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { createTestPrisma, resetTestData, testSchema } from './helpers/database';

/**
 * Le journal d'audit est append-only (CLAUDE.md §5). C'est l'argument
 * probant du produit : ces tests le prouvent au niveau de la base, pas
 * seulement par l'absence de route.
 */
describe('journal d’audit append-only', () => {
  let prisma: PrismaClient;
  let tenantId: string;
  let eventId: string;

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
  });

  afterAll(async () => {
    await resetTestData(prisma);
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetTestData(prisma);
    const tenant = await prisma.tenant.create({
      data: { name: 'Locataire audit', slug: 'locataire-audit' },
    });
    tenantId = tenant.id;
    const event = await prisma.auditEvent.create({
      data: { tenantId, action: 'LOGIN', ip: '10.0.0.1', detail: { email: 'a@demo.cm' } },
    });
    eventId = event.id;
  });

  it('accepte l’écriture d’un événement', async () => {
    const events = await prisma.auditEvent.findMany({ where: { tenantId } });
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe('LOGIN');
    expect(events[0]?.at).toBeInstanceOf(Date);
  });

  it('refuse la modification d’un événement', async () => {
    await expect(
      prisma.auditEvent.update({ where: { id: eventId }, data: { ip: '10.0.0.2' } }),
    ).rejects.toThrow(/append-only/);
  });

  it('refuse la suppression d’un événement', async () => {
    await expect(prisma.auditEvent.delete({ where: { id: eventId } })).rejects.toThrow(
      /append-only/,
    );
  });

  it('refuse une suppression de masse', async () => {
    await expect(prisma.auditEvent.deleteMany({ where: { tenantId } })).rejects.toThrow(
      /append-only/,
    );
  });

  it('refuse un UPDATE en SQL direct', async () => {
    await expect(
      prisma.$executeRawUnsafe(`UPDATE ${testSchema()}.audit_events SET action = 'PURGE'`),
    ).rejects.toThrow(/append-only/);
  });

  it('refuse un TRUNCATE, qui contournerait les déclencheurs par ligne', async () => {
    await expect(prisma.$executeRawUnsafe(`TRUNCATE ${testSchema()}.audit_events`)).rejects.toThrow(
      /append-only/,
    );
  });

  it('laisse l’événement intact après chaque tentative', async () => {
    await prisma.auditEvent
      .update({ where: { id: eventId }, data: { ip: '10.0.0.2' } })
      .catch(() => undefined);
    const event = await prisma.auditEvent.findUniqueOrThrow({ where: { id: eventId } });
    expect(event.ip).toBe('10.0.0.1');
  });

  /**
   * Un seul mécanisme d'écriture — CLAUDE.md §9.34.
   *
   * Le journal ne vaut que si tout y entre par la même porte. Une seconde
   * porte, ouverte pour un cas particulier, échapperait aux garanties de la
   * première — et personne ne s'en apercevrait avant un contrôle.
   */
  it('n’écrit au journal que par AuditService', async () => {
    const racine = join(__dirname, '..', 'src');
    const fichiers: string[] = [];
    const parcourir = async (dossier: string): Promise<void> => {
      for (const entree of await readdir(dossier, { withFileTypes: true })) {
        const chemin = join(dossier, entree.name);
        if (entree.isDirectory()) await parcourir(chemin);
        else if (entree.name.endsWith('.ts')) fichiers.push(chemin);
      }
    };
    await parcourir(racine);

    const fautifs: string[] = [];
    for (const fichier of fichiers) {
      const contenu = await readFile(fichier, 'utf8');
      // `auditEvent.create` ailleurs que dans le service, c'est une seconde
      // porte. La lecture (`findMany`, `count`) reste libre.
      if (/auditEvent\.(create|createMany|update|delete)/.test(contenu)) {
        if (!fichier.endsWith(join('audit', 'audit.service.ts'))) fautifs.push(fichier);
      }
    }
    expect(fautifs).toEqual([]);
  });
});
