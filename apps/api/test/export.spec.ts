import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import JSZip from 'jszip';
import {
  buildWavPcm,
  EXPORT_FICHE_JSON,
  EXPORT_FICHE_PDF,
  INGEST_SAMPLE_RATE,
  type ExportManifest,
} from '@voxecho/shared';
import { hashPassword } from '../src/auth/password';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026';

/**
 * Export horodaté — CLAUDE.md §6 et §9.8.
 *
 * Un export est ce qui sort du produit : il circulera par courriel, sur une
 * clé, dans un dossier de contrôle, loin du portail qui l'a produit. Ces
 * tests vérifient qu'il se suffit à lui-même, et qu'il ne ment jamais sur ce
 * qu'il transporte.
 */
describe('export d’un enregistrement', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let passwordHash: string;
  let storageDir: string;
  let banque: string;
  let microfinance: string;
  let audio: Uint8Array;
  let empreinte: string;
  let appelId: string;
  let cheminAudio: string;
  let nomAudio: string;

  beforeAll(async () => {
    storageDir = process.env.STORAGE_DIR as string;
    prisma = createTestPrisma();
    await prisma.$connect();
    passwordHash = await hashPassword(MOT_DE_PASSE);
    app = await createTestApp();
    audio = buildWavPcm({ samples: new Int16Array(INGEST_SAMPLE_RATE * 2) });
    empreinte = createHash('sha256').update(audio).digest('hex');
  });

  afterAll(async () => {
    await resetTestData(prisma);
    await prisma.$disconnect();
    await app.close();
    await rm(storageDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await resetTestData(prisma);
    await rm(storageDir, { recursive: true, force: true });

    banque = (
      await prisma.tenant.create({ data: { name: 'Banque de démonstration', slug: 'banque-a' } })
    ).id;
    microfinance = (await prisma.tenant.create({ data: { name: 'MFI B', slug: 'mfi-b' } })).id;

    for (const [email, tenantId, role] of [
      ['admin@a.cm', banque, 'ADMIN'],
      ['superviseur@a.cm', banque, 'SUPERVISOR'],
      ['auditeur@a.cm', banque, 'AUDITOR'],
      ['admin@b.cm', microfinance, 'ADMIN'],
    ] as const) {
      await prisma.user.create({ data: { tenantId, email, passwordHash, role } });
    }

    nomAudio = '20260901-143012_16778001_1001_699112233.wav';
    const filePath = `${banque}/2026/09/${nomAudio}`;
    cheminAudio = join(storageDir, filePath);
    await mkdir(dirname(cheminAudio), { recursive: true });
    await writeFile(cheminAudio, audio);

    appelId = (
      await prisma.recording.create({
        data: {
          tenantId: banque,
          refci: '16778001',
          near: '1001',
          far: '699112233',
          direction: 'outbound',
          startedAt: new Date('2026-09-01T14:30:12+01:00'),
          durationSec: 183,
          filePath,
          sha256: empreinte,
          sizeBytes: BigInt(audio.byteLength),
          source: 'cucm_bib',
        },
      })
    ).id;
  });

  async function jeton(email: string): Promise<string> {
    const reponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: MOT_DE_PASSE })
      .expect(200);
    return (reponse.body as { accessToken: string }).accessToken;
  }

  /**
   * Rendue synchrone à dessein : `await` sur une requête supertest la lance,
   * et un helper `async` la lancerait avant que l'appelant ait pu y accrocher
   * son `.expect()`.
   */
  const exporter = (token: string, id = appelId) =>
    request(app.getHttpServer())
      .post(`/api/recordings/${id}/export`)
      .set('Authorization', `Bearer ${token}`)
      .responseType('blob');

  /**
   * Texte réellement dessiné dans le PDF. PDFKit comprime ses flux de
   * contenu : les lire en clair reviendrait à ne vérifier que l'en-tête du
   * fichier. On les décompresse donc, pour contrôler ce qu'un contrôleur
   * lira sur la page — pas ce que le générateur prétend y avoir mis.
   */
  function texteDuPdf(pdf: Buffer): string {
    const brut = pdf.toString('latin1');
    let contenu = '';
    const marqueur = /stream\r?\n/g;
    let debut: RegExpExecArray | null;
    while ((debut = marqueur.exec(brut)) !== null) {
      const fin = brut.indexOf('endstream', debut.index);
      if (fin === -1) continue;
      const flux = pdf.subarray(debut.index + debut[0].length, fin);
      try {
        contenu += inflateSync(flux).toString('latin1');
      } catch {
        // Flux non compressé ou binaire (police) : sans intérêt ici.
        contenu += flux.toString('latin1');
      }
    }

    // On ne garde que les fragments de chaîne, dans l'ordre. Le crénage
    // découpe les mots — « AVERTISSEMENT » s'écrit `[A 30 VERTISSEMENT]`,
    // la paire « AV » étant resserrée — et chercher une sous-chaîne dans le
    // flux brut ne trouverait donc jamais un mot qui est pourtant sur la page.
    const jetons = /<([0-9A-Fa-f]+)>|\(((?:\\.|[^\\)])*)\)/g;
    let texte = '';
    let jeton: RegExpExecArray | null;
    while ((jeton = jetons.exec(contenu)) !== null) {
      texte +=
        jeton[1] !== undefined
          ? Buffer.from(jeton[1], 'hex').toString('latin1')
          : (jeton[2] ?? '').replace(/\\([()\\])/g, '$1');
    }
    return texte;
  }

  async function ouvrirArchive(corps: Buffer) {
    const zip = await JSZip.loadAsync(corps);
    const manifest = JSON.parse(
      await zip.file(EXPORT_FICHE_JSON)!.async('string'),
    ) as ExportManifest;
    return {
      zip,
      manifest,
      audio: await zip.file(nomAudio)!.async('nodebuffer'),
      pdf: await zip.file(EXPORT_FICHE_PDF)!.async('nodebuffer'),
    };
  }

  it('rend une archive contenant l’audio et les deux fiches', async () => {
    const reponse = await exporter(await jeton('auditeur@a.cm')).expect(200);

    expect(reponse.headers['content-type']).toBe('application/zip');
    expect(reponse.headers['content-disposition']).toContain(
      'attachment; filename="export-20260901-143012_16778001_1001_699112233.zip"',
    );
    expect(reponse.headers['cache-control']).toBe('private, no-store');

    const archive = await ouvrirArchive(reponse.body as Buffer);
    expect(Object.keys(archive.zip.files).sort()).toEqual(
      [nomAudio, EXPORT_FICHE_PDF, EXPORT_FICHE_JSON].sort(),
    );
  });

  it('exporte l’audio bit pour bit : ce qui sort est ce qui a été ingéré', async () => {
    const reponse = await exporter(await jeton('auditeur@a.cm')).expect(200);
    const archive = await ouvrirArchive(reponse.body as Buffer);

    expect(createHash('sha256').update(archive.audio).digest('hex')).toBe(empreinte);
    expect(archive.audio.byteLength).toBe(audio.byteLength);
  });

  it('porte sur la fiche l’appel, le demandeur et l’empreinte', async () => {
    const reponse = await exporter(await jeton('auditeur@a.cm')).expect(200);
    const { manifest } = await ouvrirArchive(reponse.body as Buffer);

    expect(manifest).toMatchObject({
      schema: 1,
      produit: 'VoxEcho Record',
      demandeur: { email: 'auditeur@a.cm', role: 'AUDITOR' },
      locataire: { id: banque, nom: 'Banque de démonstration' },
      appel: {
        id: appelId,
        refci: '16778001',
        poste: '1001',
        correspondant: '699112233',
        sens: 'outbound',
        dureeSec: 183,
        source: 'cucm-bib',
        statut: 'stored',
        sousConservationForcee: false,
      },
      preuve: {
        sha256Ingestion: empreinte,
        sha256Export: empreinte,
        integrite: 'concordante',
        octets: audio.byteLength,
        fichierAudio: nomAudio,
      },
    });
    expect(Date.parse(manifest.emisLe)).not.toBeNaN();
    expect(manifest.mention).toMatch(/journal d’audit/);
  });

  it('produit une fiche PDF véritable, pas un fichier vide', async () => {
    const reponse = await exporter(await jeton('admin@a.cm')).expect(200);
    const archive = await ouvrirArchive(reponse.body as Buffer);

    expect(archive.pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(archive.pdf.byteLength).toBeGreaterThan(1000);

    const texte = texteDuPdf(archive.pdf);
    // L'empreinte figure en entier sur la page : c'est la valeur qu'un
    // contrôleur recopie depuis la feuille imprimée.
    expect(texte).toContain(empreinte);
    expect(texte).toContain('16778001');
    expect(texte).toContain('admin@a.cm');
    expect(texte).toContain('Banque de démonstration');
  });

  it('signale la conservation forcée sur la fiche', async () => {
    await request(app.getHttpServer())
      .post(`/api/recordings/${appelId}/holds`)
      .set('Authorization', `Bearer ${await jeton('admin@a.cm')}`)
      .send({
        reason: 'Contentieux 2026-114 : pièce réclamée par le contrôle.',
        caseReference: 'REQ-2026-118',
      })
      .expect(201);

    const reponse = await exporter(await jeton('auditeur@a.cm')).expect(200);
    const { manifest } = await ouvrirArchive(reponse.body as Buffer);
    expect(manifest.appel.sousConservationForcee).toBe(true);
  });

  it('inscrit l’export au journal, avec le résultat de la vérification', async () => {
    const reponse = await exporter(await jeton('auditeur@a.cm')).expect(200);
    const { manifest } = await ouvrirArchive(reponse.body as Buffer);

    const trace = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'EXPORT' } });
    expect(trace.recordingId).toBe(appelId);
    expect(trace.detail).toMatchObject({
      exportId: manifest.exportId,
      refci: '16778001',
      sha256Ingestion: empreinte,
      sha256Export: empreinte,
      integrite: 'concordante',
      fichiers: [nomAudio, EXPORT_FICHE_PDF, EXPORT_FICHE_JSON],
    });
    // L'identifiant du journal et celui de la fiche sont le même : on
    // retrouve l'un depuis l'autre.
    expect(reponse.headers['x-export-id']).toBe(manifest.exportId);
  });

  describe('quand l’empreinte ne concorde plus', () => {
    beforeEach(async () => {
      // Le fichier a bougé sur le disque depuis son ingestion.
      await writeFile(cheminAudio, buildWavPcm({ samples: new Int16Array(INGEST_SAMPLE_RATE) }));
    });

    it('exporte quand même, mais ne prétend pas que la pièce est intacte', async () => {
      const reponse = await exporter(await jeton('auditeur@a.cm')).expect(200);
      expect(reponse.headers['x-export-integrite']).toBe('divergente');

      const { manifest, pdf } = await ouvrirArchive(reponse.body as Buffer);
      expect(manifest.preuve.integrite).toBe('divergente');
      expect(manifest.preuve.sha256Ingestion).toBe(empreinte);
      expect(manifest.preuve.sha256Export).not.toBe(empreinte);
      // L'avertissement est sur la page, pas seulement dans le json.
      expect(texteDuPdf(pdf)).toContain('AVERTISSEMENT');
    });

    it('consigne l’écart au journal : c’est là qu’on datera l’incident', async () => {
      await exporter(await jeton('auditeur@a.cm')).expect(200);
      const trace = await prisma.auditEvent.findFirstOrThrow({ where: { action: 'EXPORT' } });
      expect(trace.detail).toMatchObject({ integrite: 'divergente' });
    });
  });

  it('refuse d’exporter un appel purgé : il n’y a plus d’audio', async () => {
    await prisma.recording.update({ where: { id: appelId }, data: { status: 'purged' } });
    await exporter(await jeton('admin@a.cm')).expect(410);
    expect(await prisma.auditEvent.count({ where: { action: 'EXPORT' } })).toBe(0);
  });

  it('rend 404 quand le fichier a disparu du stockage', async () => {
    await rm(cheminAudio);
    await exporter(await jeton('admin@a.cm')).expect(404);
    expect(await prisma.auditEvent.count({ where: { action: 'EXPORT' } })).toBe(0);
  });

  it('n’exporte pas l’appel d’un autre locataire', async () => {
    await exporter(await jeton('admin@b.cm')).expect(404);
    expect(await prisma.auditEvent.count({ where: { action: 'EXPORT' } })).toBe(0);
  });

  it('refuse un export non authentifié', async () => {
    await request(app.getHttpServer()).post(`/api/recordings/${appelId}/export`).expect(401);
  });

  it.each(['admin@a.cm', 'auditeur@a.cm'])(
    'est ouvert à %s : sortir une pièce fait partie du métier d’audit, la trace est le contrôle',
    async (email) => {
      await exporter(await jeton(email)).expect(200);
    },
  );

  it('est fermé au SUPERVISOR : l’archive contient l’audio (§9.9)', async () => {
    await exporter(await jeton('superviseur@a.cm')).expect(403);
    expect(await prisma.auditEvent.count({ where: { action: 'EXPORT' } })).toBe(0);
  });

  it('compte un export par demande', async () => {
    await exporter(await jeton('auditeur@a.cm')).expect(200);
    await exporter(await jeton('auditeur@a.cm')).expect(200);
    const traces = await prisma.auditEvent.findMany({ where: { action: 'EXPORT' } });
    expect(traces).toHaveLength(2);
    // Deux exports, deux identifiants : on ne confond pas deux sorties de la
    // même pièce.
    const ids = traces.map((t) => (t.detail as { exportId: string }).exportId);
    expect(new Set(ids).size).toBe(2);
  });
});
