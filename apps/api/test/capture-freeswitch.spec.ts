import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { buildWavPcm, INGEST_SAMPLE_RATE } from '@voxecho/shared';
import { IngestionService } from '../src/ingestion/ingestion.service';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';
import type { INestApplication } from '@nestjs/common';

const SCRIPT = join(__dirname, '..', '..', '..', 'tools', 'freeswitch', 'post-enregistrement.sh');

/**
 * Le script de capture, ingéré par le portail — CLAUDE.md §7 (S5) et §9.17.
 *
 * Le §7 promet qu'au branchement réel, « AUCUN changement n'est attendu dans
 * apps/ ; si un changement est nécessaire, c'est un bug du contrat ». Cette
 * promesse ne se vérifie qu'ici : le script post-enregistrement dépose, et
 * l'ingestion — celle du produit, sans aménagement — range.
 *
 * Les tests de `tools/freeswitch` prouvent que le dépôt satisfait les
 * validateurs du contrat ; celui-ci prouve qu'il satisfait le portail. Ce
 * n'est pas la même chose : un dépôt peut être conforme au schéma et
 * inexploitable, par exemple si le locataire visé n'existe pas.
 */
describe('capture FreeSWITCH ingérée par le portail', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let ingestion: IngestionService;
  let banque: string;
  let enregistrements: string;

  const ingestDir = process.env.INGEST_DIR as string;
  const storageDir = process.env.STORAGE_DIR as string;
  const quarantineDir = process.env.QUARANTINE_DIR as string;

  /** Un WAV comme en produit FreeSWITCH réglé sur record_sample_rate=8000. */
  async function enregistrer(nom: string, secondes: number): Promise<string> {
    const chemin = join(enregistrements, nom);
    await writeFile(
      chemin,
      buildWavPcm({ samples: new Int16Array(INGEST_SAMPLE_RATE * secondes) }),
    );
    return chemin;
  }

  function deposer(options: Record<string, string>): string {
    return execFileSync(
      'bash',
      [SCRIPT, ...Object.entries(options).flatMap(([cle, valeur]) => [cle, valeur])],
      { encoding: 'utf8' },
    );
  }

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    app = await createTestApp();
    ingestion = app.get(IngestionService);
    enregistrements = join(storageDir, '..', 'freeswitch-recordings');
  });

  afterAll(async () => {
    await resetTestData(prisma);
    await prisma.$disconnect();
    await app.close();
    await rm(enregistrements, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetTestData(prisma);
    for (const repertoire of [ingestDir, storageDir, quarantineDir, enregistrements]) {
      await rm(repertoire, { recursive: true, force: true });
      await mkdir(repertoire, { recursive: true });
    }
    banque = (
      await prisma.tenant.create({ data: { name: 'Banque de la CEMAC', slug: 'banque-cemac' } })
    ).id;
  });

  it('un appel déposé par le script est rangé sans qu’aucun code de apps/ ait bougé', async () => {
    deposer({
      '--fichier': await enregistrer('appel.wav', 4),
      '--locataire': 'banque-cemac',
      '--refci': '16778001',
      '--poste': '1001',
      '--correspondant': '699112233',
      '--sens': 'inbound',
      '--debut': '2026-09-01T14:30:12+01:00',
      '--duree': '4',
      '--categorie': 'confirmation_cheque',
      '--ingest-dir': ingestDir,
    });

    await ingestion.scan();

    const enregistrement = await prisma.recording.findFirstOrThrow({ where: { tenantId: banque } });
    expect(enregistrement).toMatchObject({
      refci: '16778001',
      near: '1001',
      far: '699112233',
      direction: 'inbound',
      durationSec: 4,
      source: 'cucm_bib',
      status: 'stored',
      operationCategory: 'confirmation_cheque',
    });
    // Rangé sous l'identifiant du locataire et le mois du radical (§9.3).
    expect(enregistrement.filePath).toBe(
      `${banque}/2026/09/20260901-143012_16778001_1001_699112233.wav`,
    );
    expect(enregistrement.sha256).toHaveLength(64);
    expect(await prisma.auditEvent.count({ where: { action: 'INGEST' } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { action: 'QUARANTINE' } })).toBe(0);
  });

  it('un appel sans catégorie déclarée est rangé en « autre », schéma inchangé', async () => {
    deposer({
      '--fichier': await enregistrer('sans-categorie.wav', 2),
      '--locataire': 'banque-cemac',
      '--refci': '16778002',
      '--poste': '1002',
      '--correspondant': '677889900',
      '--sens': 'outbound',
      '--debut': '2026-09-01T09:05:00+01:00',
      '--duree': '2',
      '--ingest-dir': ingestDir,
    });

    await ingestion.scan();

    // C'est la condition posée au §9.10 : un script écrit avant la catégorie
    // reste conforme, et son dépôt est rangé en « autre ».
    const enregistrement = await prisma.recording.findFirstOrThrow({ where: { tenantId: banque } });
    expect(enregistrement.operationCategory).toBe('autre');
  });

  it('le portail reconnaît un redépôt du même appel sans créer de doublon', async () => {
    const appel = {
      '--locataire': 'banque-cemac',
      '--refci': '16778003',
      '--poste': '1003',
      '--correspondant': '655443322',
      '--sens': 'internal',
      '--debut': '2026-09-01T11:00:00+01:00',
      '--duree': '3',
      '--ingest-dir': ingestDir,
    };
    deposer({ '--fichier': await enregistrer('premier.wav', 3), ...appel });
    await ingestion.scan();

    // Le script refuse d'écraser un dépôt en attente, mais rien ne l'empêche
    // de redéposer un appel déjà ingéré : c'est au portail de le reconnaître.
    deposer({ '--fichier': await enregistrer('second.wav', 3), ...appel });
    await ingestion.scan();

    expect(await prisma.recording.count({ where: { tenantId: banque } })).toBe(1);

    // Le contrat §3 veut un « no-op tracé » : le second dépôt ne crée pas
    // d'enregistrement, mais il laisse une trace disant qu'il a été reconnu
    // et retiré. Un retrait silencieux serait indistinguable d'une perte.
    const traces = await prisma.auditEvent.findMany({
      where: { action: 'INGEST' },
      orderBy: { at: 'asc' },
    });
    expect(traces).toHaveLength(2);
    expect(traces[1]?.detail).toMatchObject({ idempotent: true });
  });

  it('un dépôt visant un locataire inconnu part en quarantaine, sans locataire à qui l’attribuer', async () => {
    deposer({
      '--fichier': await enregistrer('inconnu.wav', 2),
      '--locataire': 'banque-fantome',
      '--refci': '16778004',
      '--poste': '1004',
      '--correspondant': '699000111',
      '--sens': 'outbound',
      '--debut': '2026-09-01T12:00:00+01:00',
      '--duree': '2',
      '--ingest-dir': ingestDir,
    });

    await ingestion.scan();

    // Le script ne connaît pas la liste des locataires — il ne parle pas à
    // l'api (§3). C'est donc le portail qui tranche, et il ne crée jamais de
    // locataire implicitement (§9.2).
    expect(await prisma.recording.count()).toBe(0);
    const quarantaine = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'QUARANTINE' },
    });
    expect(quarantaine.tenantId).toBeNull();
  });
});
