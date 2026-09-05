// En tête, avant tout ce qui charge la configuration : le contrôle se joue
// sur une instance dont le chiffrement au repos est actif, comme en clientèle.
import '../test/helpers/chiffrement-actif';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import JSZip from 'jszip';
import {
  DASHBOARD_JOURS,
  EXPORT_FICHE_JSON,
  EXPORT_FICHE_PDF,
  type ExportManifest,
} from '@voxecho/shared';
import { IngestionService } from '../src/ingestion/ingestion.service';
import { hashPassword } from '../src/auth/password';
import { creerSauvegarde, type Sauvegarde } from '../src/backup/sauvegarde.service';
import { verifierSauvegarde } from '../src/backup/verification.service';
import { verifierBaseRestauree } from '../src/backup/base-restauree';
import { NOM_INVENTAIRE } from '../src/backup/manifeste';
import { pgDump } from '../src/backup/pg-dump';
import { createTestApp } from './helpers/app';
import { createTestPrisma, resetTestData, testDatabaseUrl } from './helpers/database';

const MOT_DE_PASSE = 'Demo!2026';
const SIMULATEUR = join(__dirname, '..', '..', '..', 'tools', 'simulator');
const LOT = 8;

/**
 * Sortie du jalon S4 — CLAUDE.md §7 : « scénario "contrôle COBAC" joué ».
 *
 * Un contrôleur se présente à la banque. Il ne demande pas à voir des
 * fonctionnalités : il pose des questions, et chaque réponse doit être une
 * pièce, pas une déclaration. Ce fichier est ce contrôle, joué dans l'ordre où
 * il se déroulerait — le périmètre, l'intégrité d'une conversation, qui a le
 * droit de l'entendre, ce qui protège une pièce sous enquête, comment on
 * détruit, ce que le journal en dit, et ce qui se passerait si tout brûlait.
 *
 * Rien n'est simulé sauf la téléphonie — c'est le vrai simulateur qui est
 * lancé en ligne de commande — et le temps : on ne peut pas attendre deux ans
 * qu'une conservation arrive à échéance, donc quelques appels sont vieillis en
 * base. Tout le reste est le produit tel qu'il sera livré, chiffrement au
 * repos compris.
 *
 * Il se rejoue à chaque CI, plutôt que de dépendre de quelqu'un qui se
 * souvient des commandes le jour du contrôle.
 */
describe('scénario « contrôle COBAC »', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let banque: string;
  let racineSauvegardes: string;

  const ingestDir = process.env.INGEST_DIR as string;
  const storageDir = process.env.STORAGE_DIR as string;

  /** L'appel que le contrôleur suit d'un bout à l'autre du scénario. */
  let piece: { id: string; sha256: string; sizeBytes: bigint; filePath: string; far: string };
  /** L'appel échu qui sera détruit, et celui qu'une enquête protège. */
  let aDetruire: string;
  let sousEnquete: string;

  async function jeton(email: string): Promise<string> {
    const reponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: MOT_DE_PASSE })
      .expect(200);
    return (reponse.body as { accessToken: string }).accessToken;
  }

  beforeAll(async () => {
    prisma = createTestPrisma();
    await prisma.$connect();
    app = await createTestApp();

    await resetTestData(prisma);
    await rm(ingestDir, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
    racineSauvegardes = join(storageDir, '..', 'sauvegardes-controle');
    await rm(racineSauvegardes, { recursive: true, force: true });

    banque = (
      await prisma.tenant.create({ data: { name: 'Banque de la CEMAC', slug: 'banque-cemac' } })
    ).id;
    const passwordHash = await hashPassword(MOT_DE_PASSE);
    for (const [email, role] of [
      ['conformite@banque.cm', 'ADMIN'],
      ['auditeur@banque.cm', 'AUDITOR'],
      ['superviseur@banque.cm', 'SUPERVISOR'],
    ] as const) {
      await prisma.user.create({ data: { tenantId: banque, email, passwordHash, role } });
    }

    // La téléphonie dépose, graine fixée : le contrôle se rejoue à l'identique.
    execFileSync(
      'pnpm',
      [
        'exec',
        'tsx',
        'src/index.ts',
        '--batch',
        String(LOT),
        '--tenant',
        'banque-cemac',
        '--dir',
        ingestDir,
        '--seed',
        '20260901',
      ],
      { cwd: SIMULATEUR, stdio: 'pipe' },
    );
    await app.get(IngestionService).scan();
  }, 300_000);

  afterAll(async () => {
    await resetTestData(prisma);
    await prisma.$disconnect();
    await app.close();
    await rm(ingestDir, { recursive: true, force: true });
    await rm(storageDir, { recursive: true, force: true });
    await rm(racineSauvegardes, { recursive: true, force: true });
  });

  it('1. les conversations sont rangées, empreintes, et illisibles sur le disque', async () => {
    const enregistrements = await prisma.recording.findMany({
      where: { tenantId: banque },
      orderBy: { startedAt: 'asc' },
    });
    expect(enregistrements).toHaveLength(LOT);
    expect(new Set(enregistrements.map((e) => e.sha256)).size).toBe(LOT);
    expect(await prisma.auditEvent.count({ where: { action: 'INGEST' } })).toBe(LOT);

    piece = enregistrements[0] as typeof piece;
    aDetruire = (enregistrements[1] as { id: string }).id;
    sousEnquete = (enregistrements[2] as { id: string }).id;

    // Ce qu'un contrôleur peut constater lui-même : le fichier rangé n'est pas
    // un WAV qu'on ouvre, et la base porte l'empreinte du **clair** (§9.13).
    expect(enregistrements.every((e) => e.encrypted)).toBe(true);
    const surDisque = await readFile(join(storageDir, piece.filePath));
    expect(surDisque.subarray(0, 8).toString('ascii')).toBe('VOXECHO1');
    expect(surDisque.subarray(0, 4).toString('ascii')).not.toBe('RIFF');
    expect(createHash('sha256').update(surDisque).digest('hex')).not.toBe(piece.sha256);
  });

  it('2. « combien de temps conservez-vous ? » — et on ne descend pas sans le dire', async () => {
    const admin = await jeton('conformite@banque.cm');

    const enVigueur = await request(app.getHttpServer())
      .get('/api/retention')
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);
    expect(enVigueur.body).toMatchObject({ days: 730, belowFloorReason: null, minDays: 730 });

    // Sous le plancher sans motif écrit : refusé (§9.6).
    await request(app.getHttpServer())
      .put('/api/retention')
      .set('Authorization', `Bearer ${admin}`)
      .send({ days: 90 })
      .expect(400);

    // Avec motif : accepté, mais la politique porte désormais la marque d'une
    // dérogation, et le journal dit qui l'a décidée.
    const deroge = await request(app.getHttpServer())
      .put('/api/retention')
      .set('Authorization', `Bearer ${admin}`)
      .send({ days: 90, belowFloorReason: 'Décision du comité de conformité du 2 septembre 2026' })
      .expect(200);
    expect(deroge.body).toMatchObject({ days: 90 });
    expect((deroge.body as { belowFloorReason: string }).belowFloorReason).toMatch(/comité/);

    const trace = await prisma.auditEvent.findFirst({
      where: { action: 'RETENTION_SET' },
      orderBy: { at: 'desc' },
    });
    expect(trace?.detail).toMatchObject({
      avantJours: 730,
      apresJours: 90,
      sousLePlancher: true,
      raccourcie: true,
    });

    // Le contrôle se poursuit sur la politique normale.
    await request(app.getHttpServer())
      .put('/api/retention')
      .set('Authorization', `Bearer ${admin}`)
      .send({ days: 730 })
      .expect(200);
  });

  it('3. entendre un client n’est pas un droit d’exploitation', async () => {
    const superviseur = await jeton('superviseur@banque.cm');

    // Le superviseur cherche et voit les métadonnées…
    const recherche = await request(app.getHttpServer())
      .get('/api/recordings')
      .set('Authorization', `Bearer ${superviseur}`)
      .query({ phone: piece.far })
      .expect(200);
    expect((recherche.body as { items: unknown[] }).items.length).toBeGreaterThan(0);

    // … mais il n'entend pas, et il n'emporte pas (§9.9).
    await request(app.getHttpServer())
      .post(`/api/recordings/${piece.id}/listen`)
      .set('Authorization', `Bearer ${superviseur}`)
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/recordings/${piece.id}/export`)
      .set('Authorization', `Bearer ${superviseur}`)
      .expect(403);

    // L'auditeur, lui, écoute — et le flux servi rend le clair de la preuve
    // malgré le chiffrement, ce qui est tout l'objet du §9.13.
    const auditeur = await jeton('auditeur@banque.cm');
    const ouverture = await request(app.getHttpServer())
      .post(`/api/recordings/${piece.id}/listen`)
      .set('Authorization', `Bearer ${auditeur}`)
      .expect(200);
    const { ticket } = ouverture.body as { ticket: string };

    const flux = await request(app.getHttpServer())
      .get(`/api/recordings/${piece.id}/audio`)
      .query({ ticket })
      .responseType('blob')
      .expect(200);
    const corps = Buffer.from(flux.body as Buffer);
    expect(createHash('sha256').update(corps).digest('hex')).toBe(piece.sha256);

    const ecoutes = await prisma.auditEvent.count({
      where: { action: 'LISTEN', recordingId: piece.id },
    });
    expect(ecoutes).toBe(1);
  });

  it('4. « prouvez que cette pièce est intacte » — la fiche vérifie, elle n’affirme pas', async () => {
    const reponse = await request(app.getHttpServer())
      .post(`/api/recordings/${piece.id}/export`)
      .set('Authorization', `Bearer ${await jeton('auditeur@banque.cm')}`)
      .responseType('blob')
      .expect(200);
    expect(reponse.headers['x-export-integrite']).toBe('concordante');

    const archive = await JSZip.loadAsync(Buffer.from(reponse.body as Buffer));
    expect(archive.file(EXPORT_FICHE_PDF)).not.toBeNull();
    const fiche = JSON.parse(
      await (archive.file(EXPORT_FICHE_JSON) as JSZip.JSZipObject).async('string'),
    ) as ExportManifest;

    // L'empreinte est recalculée sur le fichier au moment de l'export et
    // confrontée à celle de l'ingestion — en entier, pour être comparable.
    expect(fiche.preuve.sha256Ingestion).toBe(piece.sha256);
    expect(fiche.preuve.sha256Export).toBe(piece.sha256);
    expect(fiche.preuve.integrite).toBe('concordante');
    expect(fiche.demandeur.email).toBe('auditeur@banque.cm');

    // L'audio sort sous le nom que lui donne le contrat §3.
    expect(archive.file(fiche.preuve.fichierAudio)).not.toBeNull();

    const trace = await prisma.auditEvent.findFirst({
      where: { action: 'EXPORT', recordingId: piece.id },
      orderBy: { at: 'desc' },
    });
    expect(trace?.detail).toMatchObject({ integrite: 'concordante' });
  });

  it('5. une pièce sous enquête ne se détruit pas, et cela se lit', async () => {
    const pose = await request(app.getHttpServer())
      .post(`/api/recordings/${sousEnquete}/holds`)
      .set('Authorization', `Bearer ${await jeton('superviseur@banque.cm')}`)
      .send({
        reason: 'Réquisition judiciaire n° 2026-118 du parquet de Douala',
        caseReference: 'REQ-2026-118',
      })
      .expect(201);
    expect((pose.body as { releasedAt: string | null }).releasedAt).toBeNull();

    const historique = await request(app.getHttpServer())
      .get(`/api/recordings/${sousEnquete}/holds`)
      .set('Authorization', `Bearer ${await jeton('auditeur@banque.cm')}`)
      .expect(200);
    expect((historique.body as unknown[]).length).toBe(1);

    expect(await prisma.auditEvent.count({ where: { action: 'HOLD_SET' } })).toBe(1);
  });

  it('6. ce qui est échu se détruit sur pièce, et jamais tout seul', async () => {
    // Le seul artifice du scénario : deux appels vieillis au-delà de deux ans,
    // faute de pouvoir attendre. L'un est sous conservation forcée.
    const echu = new Date('2023-01-15T09:00:00Z');
    await prisma.recording.updateMany({
      where: { id: { in: [aDetruire, sousEnquete] } },
      data: { startedAt: echu },
    });

    const admin = await jeton('conformite@banque.cm');
    const rapport = await request(app.getHttpServer())
      .post('/api/purge/reports')
      .set('Authorization', `Bearer ${admin}`)
      .expect(201);
    const resume = rapport.body as { id: string; candidateCount: number; blockedCount: number };

    // Le rapport énumère ce qui serait détruit **et** ce qu'une conservation
    // forcée épargne : un rapport muet sur les épargnés laisserait croire
    // qu'il n'y avait rien à protéger.
    expect(resume.candidateCount).toBe(1);
    expect(resume.blockedCount).toBe(1);

    const detail = await request(app.getHttpServer())
      .get(`/api/purge/reports/${resume.id}`)
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);
    const items = (
      detail.body as { items: { recordingId: string; blockingReason: string | null }[] }
    ).items;
    expect(items.find((item) => item.recordingId === sousEnquete)?.blockingReason).toMatch(
      /Réquisition judiciaire/,
    );

    // L'exécution désigne le rapport et le rejoue ; elle se motive.
    await request(app.getHttpServer())
      .post(`/api/purge/reports/${resume.id}/execute`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ reason: 'Échéance de conservation atteinte, validée par la conformité' })
      .expect(200);

    const detruit = await prisma.recording.findUniqueOrThrow({ where: { id: aDetruire } });
    const epargne = await prisma.recording.findUniqueOrThrow({ where: { id: sousEnquete } });
    expect(detruit.status).toBe('purged');
    expect(epargne.status).toBe('stored');

    // Ce qui reste d'un appel purgé : sa fiche, son empreinte, sa trace — et
    // une écoute qui rend 410, jamais 404 (§9.7).
    expect(detruit.sha256).toHaveLength(64);
    await expect(readFile(join(storageDir, detruit.filePath))).rejects.toThrow();
    await request(app.getHttpServer())
      .post(`/api/recordings/${aDetruire}/listen`)
      .set('Authorization', `Bearer ${await jeton('auditeur@banque.cm')}`)
      .expect(410);

    // Le fichier de la pièce épargnée, lui, est intact et toujours scellé.
    const scelle = await readFile(join(storageDir, epargne.filePath));
    expect(scelle.subarray(0, 8).toString('ascii')).toBe('VOXECHO1');

    const purges = await prisma.auditEvent.findMany({ where: { action: 'PURGE' } });
    expect(purges).toHaveLength(1);
    expect(purges[0]?.detail).toMatchObject({
      sha256: detruit.sha256,
      rapportId: resume.id,
      politiqueJours: 730,
    });
  });

  it('7. « montrez-moi qui a écouté quoi » — le journal se lit et s’extrait', async () => {
    const auditeur = await jeton('auditeur@banque.cm');

    const journal = await request(app.getHttpServer())
      .get('/api/audit')
      .set('Authorization', `Bearer ${auditeur}`)
      .query({ action: 'LISTEN' })
      .expect(200);
    const items = (journal.body as { items: { action: string; actorEmail: string | null }[] })
      .items;
    expect(items).toHaveLength(1);
    expect(items[0]?.actorEmail).toBe('auditeur@banque.cm');

    // L'extrait sort du produit : il devient une pièce, donc il se trace.
    const csv = await request(app.getHttpServer())
      .get('/api/audit/export.csv')
      .set('Authorization', `Bearer ${auditeur}`)
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.startsWith('﻿')).toBe(true);
    expect(csv.text.split('\n')[0]).toContain(';');

    const trace = await prisma.auditEvent.findFirst({
      where: { action: 'EXPORT', recordingId: null },
      orderBy: { at: 'desc' },
    });
    expect(trace?.detail).toMatchObject({ objet: 'journal-audit' });

    // Le journal dit qui a entendu quoi : le superviseur, qui n'entend pas,
    // n'y a pas accès non plus (§9.11).
    await request(app.getHttpServer())
      .get('/api/audit')
      .set('Authorization', `Bearer ${await jeton('superviseur@banque.cm')}`)
      .expect(403);

    // Et rien de tout cela ne se réécrit.
    await expect(prisma.auditEvent.deleteMany({ where: { tenantId: banque } })).rejects.toThrow(
      /append-only/,
    );
  });

  it('8. « et si tout brûlait ? » — la sauvegarde se prend, se vérifie, se constate', async () => {
    const cleMaitre = Buffer.from(process.env.STORAGE_MASTER_KEY as string, 'base64');

    const prise: Sauvegarde = await creerSauvegarde({
      prisma,
      destination: racineSauvegardes,
      storageDir,
      databaseUrl: testDatabaseUrl(),
      cleMaitre,
      version: 'controle-cobac',
      dumper: pgDump,
    });

    // La prise décrit l'instance telle qu'elle est à la fin du contrôle : une
    // pièce détruite, sept conservées, toutes scellées.
    expect(prise.manifeste.stockage.pieces).toBe(LOT);
    expect(prise.manifeste.stockage.purgees).toBe(1);
    expect(prise.manifeste.stockage.enClair).toBe(0);
    // La clé n'est pas dans la sauvegarde : seule son empreinte y est.
    expect(prise.manifeste.cleMaitre.empreinte).toMatch(/^[0-9a-f]{32}$/);

    const verification = await verifierSauvegarde({
      repertoire: prise.repertoire,
      cleMaitre,
      empreinteAttendue: prise.empreinte,
      storageDir,
    });
    expect(verification.anomalies).toEqual([]);
    expect(verification.cleMaitre).toBe('concorde');
    expect(verification.stockage).toMatchObject({ attendues: LOT - 1, verifiees: LOT - 1 });

    // Une clé qui n'est pas la bonne ne rendrait rien : c'est ce que le
    // contrôleur doit entendre sur la garde de la clé (§9.14).
    const avecUneAutreCle = await verifierSauvegarde({
      repertoire: prise.repertoire,
      cleMaitre: randomBytes(32),
      storageDir,
    });
    expect(avecUneAutreCle.cleMaitre).toBe('diverge');
    expect(avecUneAutreCle.restaurable).toBe(false);

    // Et la base rend bien ce que la prise annonçait (§9.15).
    const constat = await verifierBaseRestauree({
      prisma,
      manifeste: prise.manifeste,
      cheminInventaire: join(prise.repertoire, NOM_INVENTAIRE),
      cible: testDatabaseUrl(),
    });
    expect(constat.anomalies).toEqual([]);
    expect(constat.pieces).toMatchObject({ attendues: LOT, retrouvees: LOT, enTrop: 0 });
  }, 120_000);

  it('9. le tableau de bord dit l’exploitation, jamais qui a écouté quoi', async () => {
    // Ouvert au superviseur, à qui le journal est fermé : c'est la ligne du
    // §9.12, et elle se constate ici plutôt que de se raconter.
    const reponse = await request(app.getHttpServer())
      .get('/api/dashboard')
      .set('Authorization', `Bearer ${await jeton('superviseur@banque.cm')}`)
      .expect(200);

    const corps = reponse.body as {
      totaux: {
        appelsConserves: number;
        appelsPurges: number;
        sousConservationForcee: number;
        stockageOctets: number;
      };
      retention: { days: number; belowFloorReason: string | null };
      volumeParJour: { jour: string; appels: number }[];
    };

    // Les chiffres du contrôle : sept conversations conservées, une détruite,
    // une sous conservation forcée, et la politique remise à deux ans.
    expect(corps.totaux).toMatchObject({
      appelsConserves: LOT - 1,
      appelsPurges: 1,
      sousConservationForcee: 1,
    });
    expect(corps.retention).toMatchObject({ days: 730, belowFloorReason: null });

    // Le stockage ne compte que ce qui pèse sur le disque : la pièce purgée
    // garde sa fiche et ne compte plus (§9.12).
    const conserves = await prisma.recording.findMany({
      where: { tenantId: banque, status: 'stored' },
      select: { sizeBytes: true },
    });
    expect(corps.totaux.stockageOctets).toBe(
      conserves.reduce((somme, ligne) => somme + Number(ligne.sizeBytes), 0),
    );

    // Les jours creux sont dessinés à zéro, jamais omis : un graphe qui saute
    // les journées vides dessine une activité continue là où le service a
    // chômé.
    expect(corps.volumeParJour).toHaveLength(DASHBOARD_JOURS);
    expect(corps.volumeParJour.some((jour) => jour.appels === 0)).toBe(true);

    // Et rien, dans ce que voit un superviseur, ne dit qui a écouté quoi.
    expect(JSON.stringify(corps)).not.toMatch(/auditeur@banque\.cm/);
    expect(JSON.stringify(corps)).not.toMatch(/LISTEN/);
  });
});
