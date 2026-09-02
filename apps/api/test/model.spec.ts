import type { PrismaClient } from '@prisma/client';
import { createTestPrisma, resetTestData } from './helpers/database';

/** Vérifie les invariants du modèle de CLAUDE.md §5. */
describe('modèle de données', () => {
  let prisma: PrismaClient;
  let banque: string;
  let microfinance: string;

  const enregistrement = (tenantId: string, radical: string) => ({
    tenantId,
    refci: '16778001',
    near: '1001',
    far: '699112233',
    direction: 'outbound' as const,
    startedAt: new Date('2026-09-01T14:30:12+01:00'),
    durationSec: 183,
    filePath: `${tenantId}/2026/09/${radical}.wav`,
    sha256: 'a'.repeat(64),
    sizeBytes: BigInt(2_928_000),
    source: 'cucm_bib' as const,
  });

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
    banque = (await prisma.tenant.create({ data: { name: 'Banque A', slug: 'banque-a' } })).id;
    microfinance = (await prisma.tenant.create({ data: { name: 'MFI B', slug: 'mfi-b' } })).id;
  });

  it('crée un enregistrement avec toutes les preuves d’intégrité', async () => {
    const created = await prisma.recording.create({
      data: enregistrement(banque, '20260901-143012_16778001_1001_699112233'),
    });
    expect(created.status).toBe('stored');
    expect(created.sha256).toHaveLength(64);
    expect(created.sizeBytes).toBe(BigInt(2_928_000));
    expect(created.source).toBe('cucm_bib');
  });

  it('prépare le chiffrement au repos sans migration ultérieure (S4)', async () => {
    const created = await prisma.recording.create({
      data: enregistrement(banque, '20260901-143013_16778002_1001_699112233'),
    });
    expect(created.encrypted).toBe(false);
    expect(created.keyRef).toBeNull();
  });

  it('rend l’ingestion idempotente : même chemin, même locataire = refus', async () => {
    const donnees = enregistrement(banque, '20260901-143012_16778001_1001_699112233');
    await prisma.recording.create({ data: donnees });
    await expect(prisma.recording.create({ data: donnees })).rejects.toThrow();
  });

  it('autorise le même nom de fichier chez deux locataires distincts', async () => {
    const radical = '20260901-143012_16778001_1001_699112233';
    await prisma.recording.create({ data: enregistrement(banque, radical) });
    const autre = { ...enregistrement(microfinance, radical) };
    await expect(prisma.recording.create({ data: autre })).resolves.toBeDefined();
  });

  it('cloisonne les enregistrements par locataire', async () => {
    await prisma.recording.create({
      data: enregistrement(banque, '20260901-143012_16778001_1001_699112233'),
    });
    await prisma.recording.create({
      data: enregistrement(microfinance, '20260901-150000_16778009_2001_677889900'),
    });

    const vueBanque = await prisma.recording.findMany({ where: { tenantId: banque } });
    expect(vueBanque).toHaveLength(1);
    expect(vueBanque[0]?.tenantId).toBe(banque);
  });

  it('refuse deux comptes avec la même adresse, même sur des locataires différents', async () => {
    await prisma.user.create({
      data: { tenantId: banque, email: 'a@demo.cm', passwordHash: 'x', role: 'ADMIN' },
    });
    await expect(
      prisma.user.create({
        data: { tenantId: microfinance, email: 'a@demo.cm', passwordHash: 'x', role: 'ADMIN' },
      }),
    ).rejects.toThrow();
  });

  it('crée un compte verrouillable et non verrouillé par défaut', async () => {
    const user = await prisma.user.create({
      data: { tenantId: banque, email: 'b@demo.cm', passwordHash: 'x', role: 'AUDITOR' },
    });
    expect(user.active).toBe(true);
    expect(user.failedLoginAttempts).toBe(0);
    expect(user.lockedUntil).toBeNull();
  });

  it('n’autorise qu’une politique de rétention par périmètre et par locataire', async () => {
    await prisma.retentionPolicy.create({
      data: { tenantId: banque, days: 3650, appliesTo: 'all' },
    });
    await expect(
      prisma.retentionPolicy.create({ data: { tenantId: banque, days: 1825, appliesTo: 'all' } }),
    ).rejects.toThrow();
    await expect(
      prisma.retentionPolicy.create({
        data: { tenantId: microfinance, days: 1825, appliesTo: 'all' },
      }),
    ).resolves.toBeDefined();
  });

  it('rattache un legal hold à un enregistrement et à son auteur', async () => {
    const user = await prisma.user.create({
      data: { tenantId: banque, email: 'c@demo.cm', passwordHash: 'x', role: 'ADMIN' },
    });
    const recording = await prisma.recording.create({
      data: enregistrement(banque, '20260901-160000_16778010_1001_699112233'),
    });
    const hold = await prisma.legalHold.create({
      data: {
        tenantId: banque,
        recordingId: recording.id,
        setBy: user.id,
        reason: 'Contrôle COBAC 2026',
      },
    });
    expect(hold.releasedAt).toBeNull();
    expect(hold.at).toBeInstanceOf(Date);
  });

  it('refuse de supprimer un compte qui a laissé une trace au journal', async () => {
    const user = await prisma.user.create({
      data: { tenantId: banque, email: 'd@demo.cm', passwordHash: 'x', role: 'AUDITOR' },
    });
    const event = await prisma.auditEvent.create({
      data: { tenantId: banque, userId: user.id, action: 'SEARCH', detail: { q: 'test' } },
    });

    await expect(prisma.user.delete({ where: { id: user.id } })).rejects.toThrow();

    const conserve = await prisma.auditEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(conserve.userId).toBe(user.id);
  });

  it('désactive un compte au lieu de l’effacer', async () => {
    const user = await prisma.user.create({
      data: { tenantId: banque, email: 'e@demo.cm', passwordHash: 'x', role: 'AUDITOR' },
    });
    await prisma.auditEvent.create({
      data: { tenantId: banque, userId: user.id, action: 'LOGIN' },
    });
    const desactive = await prisma.user.update({
      where: { id: user.id },
      data: { active: false },
    });
    expect(desactive.active).toBe(false);
  });

  it('refuse de supprimer un locataire dont le journal n’est pas vide', async () => {
    await prisma.auditEvent.create({ data: { tenantId: banque, action: 'LOGIN' } });
    await expect(prisma.tenant.delete({ where: { id: banque } })).rejects.toThrow();
  });

  it('refuse de supprimer un enregistrement écouté', async () => {
    const recording = await prisma.recording.create({
      data: enregistrement(banque, '20260901-170000_16778011_1001_699112233'),
    });
    await prisma.auditEvent.create({
      data: { tenantId: banque, action: 'LISTEN', recordingId: recording.id },
    });
    await expect(prisma.recording.delete({ where: { id: recording.id } })).rejects.toThrow();
  });
});
