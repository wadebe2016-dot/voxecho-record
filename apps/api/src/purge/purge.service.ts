import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma, PurgeRun, Recording } from '@prisma/client';
import type {
  Page,
  PurgeReportDetail,
  PurgeReportItem,
  PurgeReportSummary,
  RetentionPolicySetResponse,
} from '@voxecho/shared';
import { AuditService } from '../audit/audit.service';
import { resoudreCheminDeDonnees } from '../config/chemins';
import { AppConfig } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { CertificatService } from './certificat.service';
import type { AuthUser } from '../auth/auth.types';
import { LegalHoldsService } from '../retention/legal-holds.service';
import { RetentionService } from '../retention/retention.service';
import { ExecutePurgeDto } from './dto/execute-purge.dto';
import { ListReportsDto } from './dto/list-reports.dto';
import { ReadReportDto } from './dto/read-report.dto';

/** Statuts d'enregistrement qu'une purge peut atteindre. */
const PURGEABLES = ['stored', 'archived'] as const;

type RunAvecComptes = PurgeRun & {
  createdByUser: { email: string };
  executedByUser: { email: string } | null;
  cancelledByUser: { email: string } | null;
};

/** Ce qu'un balayage d'échéance trouve, avant toute décision. */
interface Candidat {
  recording: Pick<Recording, 'id' | 'sizeBytes' | 'startedAt' | 'operationCategory'>;
  blocked: boolean;
  blockingReason: string | null;
  /** Durée qui a décidé du sort de cet appel — CLAUDE.md §9.31. */
  policyDays: number;
}

@Injectable()
export class PurgeService {
  private readonly logger = new Logger(PurgeService.name);
  private readonly storageDir: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly retention: RetentionService,
    private readonly holds: LegalHoldsService,
    private readonly certificats: CertificatService,
    config: AppConfig,
  ) {
    this.storageDir = resoudreCheminDeDonnees(config.get('STORAGE_DIR'));
  }

  /**
   * Simule une purge et en fige le rapport.
   *
   * Le rapport n'est pas un affichage : c'est la pièce qu'un responsable
   * conformité lit, valide, et que l'exécution désignera. Il énumère aussi ce
   * qu'une conservation forcée épargne — un rapport qui ne montrerait que ce
   * qu'on détruit laisserait croire qu'il n'y avait rien à épargner.
   */
  async simuler(user: AuthUser): Promise<PurgeReportSummary> {
    const politiques = await this.retention.lireEnsemble(user.tenantId);
    const durees = dureesParPerimetre(politiques);
    const cutoff = echeance(politiques.generale.days);
    const candidats = await this.recenser(user.tenantId, echeancesDepuis(durees), durees);

    const aDetruire = candidats.filter((c) => !c.blocked);
    const epargnes = candidats.filter((c) => c.blocked);

    const run = await this.prisma.purgeRun.create({
      data: {
        tenantId: user.tenantId,
        policyDays: politiques.generale.days,
        cutoff,
        // Toutes les durées appliquées, figées : l'exécution rejoue ce
        // document, elle ne recalcule pas à la date du jour (§9.7, §9.28).
        policyDocument: durees as unknown as Prisma.InputJsonValue,
        candidateCount: aDetruire.length,
        candidateBytes: somme(aDetruire),
        blockedCount: epargnes.length,
        blockedBytes: somme(epargnes),
        fingerprint: empreinte(candidats),
        createdBy: user.userId,
        items: {
          create: candidats.map((c) => ({
            tenantId: user.tenantId,
            recordingId: c.recording.id,
            sizeBytes: c.recording.sizeBytes,
            startedAt: c.recording.startedAt,
            operationCategory: c.recording.operationCategory,
            policyDays: c.policyDays,
            blocked: c.blocked,
            blockingReason: c.blockingReason,
            outcome: c.blocked ? ('blocked' as const) : ('candidate' as const),
          })),
        },
      },
      include: this.comptes,
    });

    // Le rapport est lui-même la trace : daté, attribué, immuable et
    // consultable. Le journal d'audit, lui, ne reçoit que ce qui détruit.
    this.logger.log(
      `Rapport de purge ${run.id} : ${aDetruire.length} candidat(s), ${epargnes.length} épargné(s) par une conservation forcée`,
    );

    return versResume(run);
  }

  /** Rapports du locataire, le plus récent en tête. */
  async lister(tenantId: string, query: ListReportsDto): Promise<Page<PurgeReportSummary>> {
    const where: Prisma.PurgeRunWhereInput = {
      tenantId,
      ...(query.status ? { status: query.status } : {}),
    };
    const [total, runs] = await this.prisma.$transaction([
      this.prisma.purgeRun.count({ where }),
      this.prisma.purgeRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: this.comptes,
      }),
    ]);

    return {
      items: runs.map(versResume),
      total,
      page: query.page,
      pageSize: query.pageSize,
      pageCount: total === 0 ? 0 : Math.ceil(total / query.pageSize),
    };
  }

  /** Un rapport et ses lignes, paginées : un rapport peut compter des milliers d'appels. */
  async lire(tenantId: string, id: string, query: ReadReportDto): Promise<PurgeReportDetail> {
    const run = await this.exigerRapport(tenantId, id);

    const where: Prisma.PurgeRunItemWhereInput = {
      purgeRunId: run.id,
      ...(query.blocked === undefined ? {} : { blocked: query.blocked }),
    };
    const [itemsTotal, items] = await this.prisma.$transaction([
      this.prisma.purgeRunItem.count({ where }),
      this.prisma.purgeRunItem.findMany({
        where,
        orderBy: { startedAt: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: {
          recording: {
            select: { refci: true, near: true, far: true, durationSec: true, sha256: true },
          },
        },
      }),
    ]);

    return {
      ...versResume(run),
      items: items.map((item): PurgeReportItem => ({
        recordingId: item.recordingId,
        refci: item.recording.refci,
        near: item.recording.near,
        far: item.recording.far,
        startedAt: item.startedAt.toISOString(),
        durationSec: item.recording.durationSec,
        sizeBytes: Number(item.sizeBytes),
        sha256: item.recording.sha256,
        outcome: item.outcome,
        blocked: item.blocked,
        blockingReason: item.blockingReason,
      })),
      itemsTotal,
      page: query.page,
      pageSize: query.pageSize,
      pageCount: itemsTotal === 0 ? 0 : Math.ceil(itemsTotal / query.pageSize),
    };
  }

  /**
   * Exécute un rapport validé — le seul acte irréversible du produit.
   *
   * Le rapport est rejoué tel qu'il a été écrit : même échéance, même
   * politique. Si l'ensemble énuméré ne correspond plus à la réalité — un
   * appel a été mis sous conservation forcée depuis, un autre a franchi
   * l'échéance, la politique a changé — l'exécution est refusée. Ce qui a été
   * autorisé doit être exactement ce qui est détruit, sinon l'autorisation ne
   * vaut rien.
   */
  async executer(
    user: AuthUser,
    id: string,
    dto: ExecutePurgeDto,
    ip: string | null,
  ): Promise<PurgeReportSummary> {
    const run = await this.exigerRapport(user.tenantId, id);
    if (run.status !== 'simulated') {
      throw new ConflictException(
        run.status === 'executed'
          ? 'Ce rapport a déjà été exécuté.'
          : 'Ce rapport a été annulé : il faut en établir un nouveau.',
      );
    }

    const politiques = await this.retention.lireEnsemble(user.tenantId);
    const durees = dureesParPerimetre(politiques);
    const figees = (run.policyDocument as Record<string, number> | null) ?? {
      all: run.policyDays,
    };
    if (JSON.stringify(durees) !== JSON.stringify(figees)) {
      throw new ConflictException(
        `La conservation est passée à ${decrireEcart(figees, durees)} depuis ce rapport : il faut en établir un nouveau.`,
      );
    }

    // Les échéances rejouées sont celles du rapport, pas celles d'aujourd'hui :
    // ce qui a été autorisé doit être exactement ce qui est détruit (§9.7).
    const actuels = await this.recenser(user.tenantId, echeancesDepuis(figees), figees);
    if (empreinte(actuels) !== run.fingerprint) {
      throw new ConflictException(
        'Les enregistrements concernés ont changé depuis ce rapport : il faut en établir un nouveau avant de purger.',
      );
    }

    const aDetruire = actuels.filter((c) => !c.blocked);
    let detruits = 0;
    let octets = 0n;

    for (const candidat of aDetruire) {
      const resultat = await this.detruire(user, candidat.recording.id, run, dto.reason, ip);
      if (resultat !== null) {
        detruits += 1;
        octets += candidat.recording.sizeBytes;
        await this.prisma.purgeRunItem.update({
          where: {
            purgeRunId_recordingId: { purgeRunId: run.id, recordingId: candidat.recording.id },
          },
          data: { outcome: resultat },
        });
      }
    }

    const acheve = await this.prisma.purgeRun.update({
      where: { id: run.id },
      data: {
        status: 'executed',
        executedBy: user.userId,
        executedAt: new Date(),
        purgedCount: detruits,
        purgedBytes: octets,
      },
      include: this.comptes,
    });

    // L'empreinte du certificat est figée ici, à l'instant de la destruction —
    // pas au premier téléchargement (§9.31). Un certificat délivré des mois
    // plus tard doit porter la valeur de ce jour-là.
    const certificat = await this.certificats.construire(user.tenantId, run.id);
    const empreinteCertificat = this.certificats.empreinte(certificat);
    await this.prisma.purgeRun.update({
      where: { id: run.id },
      data: { certificateSha256: empreinteCertificat },
    });

    this.logger.log(
      `Purge ${run.id} exécutée : ${detruits} pièce(s), certificat ${empreinteCertificat.slice(0, 16)}…`,
    );

    return versResume(acheve);
  }

  /** Abandonne un rapport : il ne pourra plus être exécuté. */
  async annuler(user: AuthUser, id: string): Promise<PurgeReportSummary> {
    const run = await this.exigerRapport(user.tenantId, id);
    if (run.status !== 'simulated') {
      throw new ConflictException('Seul un rapport encore simulé peut être annulé.');
    }
    const annule = await this.prisma.purgeRun.update({
      where: { id: run.id },
      data: { status: 'cancelled', cancelledBy: user.userId, cancelledAt: new Date() },
      include: this.comptes,
    });
    return versResume(annule);
  }

  /**
   * Détruit un enregistrement : le fichier disparaît, la ligne reste.
   *
   * Ce qui subsiste — empreinte, taille, chemin, durée — est la trace de ce
   * qui a existé et de ce qui a été détruit. Effacer la ligne effacerait la
   * preuve qu'il y avait quelque chose à purger (CLAUDE.md §9.7).
   */
  private async detruire(
    user: AuthUser,
    recordingId: string,
    run: PurgeRun,
    motif: string,
    ip: string | null,
  ): Promise<'purged' | 'missing' | null> {
    const recording = await this.prisma.recording.findFirst({
      where: { id: recordingId, tenantId: user.tenantId },
    });
    if (!recording) return null;

    const chemin = resolve(join(this.storageDir, recording.filePath));
    if (chemin !== this.storageDir && !chemin.startsWith(this.storageDir + sep)) {
      // Même garde qu'à la lecture : on ne détruit rien hors du coffre.
      this.logger.error(`Chemin hors STORAGE_DIR refusé à la purge : ${recording.filePath}`);
      return null;
    }

    let fichierAbsent = false;
    try {
      await rm(chemin);
    } catch {
      // La base connaissait l'appel, le disque ne l'avait plus. Ce n'est pas
      // une raison d'interrompre la purge, c'en est une de le consigner.
      fichierAbsent = true;
      this.logger.warn(`Purge : fichier déjà absent du stockage : ${recording.filePath}`);
    }

    await this.prisma.recording.update({
      where: { id: recording.id },
      data: { status: 'purged' },
    });

    await this.audit.record({
      tenantId: user.tenantId,
      userId: user.userId,
      action: 'PURGE',
      recordingId: recording.id,
      ip,
      detail: {
        motif,
        rapportId: run.id,
        politiqueJours: run.policyDays,
        echeance: run.cutoff.toISOString(),
        // L'empreinte de ce qui a été détruit : c'est tout ce qu'il en reste.
        sha256: recording.sha256,
        octets: Number(recording.sizeBytes),
        chemin: recording.filePath,
        debuteLe: recording.startedAt.toISOString(),
        ...(fichierAbsent ? { fichierDejaAbsent: true } : {}),
      },
    });

    return fichierAbsent ? 'missing' : 'purged';
  }

  /**
   * Recense les appels échus et l'état de conservation forcée de chacun.
   * L'échéance est passée en paramètre plutôt que recalculée : l'exécution
   * doit rejouer le rapport, pas en produire un autre.
   */
  private async recenser(
    tenantId: string,
    echeances: Map<string, Date>,
    durees: Record<string, number>,
  ): Promise<Candidat[]> {
    // La borne la plus lointaine sert de premier filtre ; chaque appel est
    // ensuite jugé sur l'échéance de sa propre catégorie (§9.28).
    const bornes = [...echeances.values()];
    const plusLointaine = new Date(Math.max(...bornes.map((borne) => borne.getTime())));

    const candidats = await this.prisma.recording.findMany({
      where: { tenantId, status: { in: [...PURGEABLES] }, startedAt: { lt: plusLointaine } },
      select: { id: true, sizeBytes: true, startedAt: true, operationCategory: true },
      orderBy: { startedAt: 'asc' },
    });

    const recordings = candidats.filter((recording) => {
      const echu = echeances.get(recording.operationCategory) ?? echeances.get('all');
      return echu !== undefined && recording.startedAt < echu;
    });
    if (recordings.length === 0) return [];

    const sousHold = await this.holds.idsSousHold(
      tenantId,
      recordings.map((r) => r.id),
    );
    const motifs = await this.motifsDeHold(tenantId, [...sousHold]);

    return recordings.map((recording) => ({
      recording,
      blocked: sousHold.has(recording.id),
      blockingReason: motifs.get(recording.id) ?? null,
      // Le certificat devra dire au nom de quelle durée la pièce a été
      // détruite, et l'enregistrement n'aura plus de fichier pour en témoigner.
      policyDays: durees[recording.operationCategory] ?? durees.all ?? 0,
    }));
  }

  private async motifsDeHold(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const holds = await this.prisma.legalHold.findMany({
      where: { tenantId, releasedAt: null, recordingId: { in: ids } },
      select: { recordingId: true, reason: true },
    });
    return new Map(holds.map((hold) => [hold.recordingId, hold.reason]));
  }

  private async exigerRapport(tenantId: string, id: string): Promise<RunAvecComptes> {
    const run = await this.prisma.purgeRun.findFirst({
      where: { id, tenantId },
      include: this.comptes,
    });
    if (!run) throw new NotFoundException('Rapport de purge introuvable.');
    return run;
  }

  private readonly comptes = {
    createdByUser: { select: { email: true } },
    executedByUser: { select: { email: true } },
    cancelledByUser: { select: { email: true } },
  } as const;
}

/**
 * Les durées appliquées, par périmètre — CLAUDE.md §9.28.
 *
 * Une catégorie sans politique propre n'apparaît pas : elle suit la générale,
 * et l'inscrire ferait croire à une décision qui n'a pas été prise.
 */
function dureesParPerimetre(politiques: RetentionPolicySetResponse): Record<string, number> {
  const durees: Record<string, number> = { all: politiques.generale.days };
  for (const entree of politiques.parCategorie) {
    if (entree.enregistree) durees[entree.appliesTo] = entree.days;
  }
  return durees;
}

/**
 * Décrit en français ce qui a changé entre deux jeux de durées. Un exploitant
 * lit « générale 730 → 1095 jours », pas deux objets JSON.
 */
function decrireEcart(avant: Record<string, number>, apres: Record<string, number>): string {
  const perimetres = [...new Set([...Object.keys(avant), ...Object.keys(apres)])].sort();
  const nommer = (perimetre: string): string =>
    perimetre === 'all' ? 'générale' : `catégorie ${perimetre}`;
  const jours = (valeur: number | undefined): string =>
    valeur === undefined ? 'suit la générale' : `${valeur} jours`;

  return perimetres
    .filter((perimetre) => avant[perimetre] !== apres[perimetre])
    .map(
      (perimetre) => `${nommer(perimetre)} ${jours(avant[perimetre])} → ${jours(apres[perimetre])}`,
    )
    .join(', ');
}

/** Une date d'échéance par périmètre, à partir des durées figées. */
function echeancesDepuis(durees: Record<string, number>): Map<string, Date> {
  return new Map(Object.entries(durees).map(([perimetre, jours]) => [perimetre, echeance(jours)]));
}

/** Date avant laquelle un appel est échu, au regard d'une durée en jours. */
function echeance(days: number): Date {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return cutoff;
}

function somme(candidats: Candidat[]): bigint {
  return candidats.reduce((total, c) => total + c.recording.sizeBytes, 0n);
}

/**
 * Empreinte de l'ensemble énuméré. L'état de conservation forcée y entre :
 * poser un hold entre la lecture du rapport et son exécution doit invalider
 * l'autorisation, pas seulement épargner l'appel en silence.
 */
function empreinte(candidats: Candidat[]): string {
  const hash = createHash('sha256');
  for (const candidat of [...candidats].sort((a, b) =>
    a.recording.id.localeCompare(b.recording.id),
  )) {
    hash.update(`${candidat.recording.id}:${candidat.blocked ? 'h' : '-'}\n`);
  }
  return hash.digest('hex');
}

function versResume(run: RunAvecComptes): PurgeReportSummary {
  return {
    id: run.id,
    status: run.status,
    policyDays: run.policyDays,
    cutoff: run.cutoff.toISOString(),
    candidateCount: run.candidateCount,
    candidateBytes: Number(run.candidateBytes),
    blockedCount: run.blockedCount,
    blockedBytes: Number(run.blockedBytes),
    createdByEmail: run.createdByUser.email,
    createdAt: run.createdAt.toISOString(),
    executedByEmail: run.executedByUser?.email ?? null,
    executedAt: run.executedAt?.toISOString() ?? null,
    purgedCount: run.purgedCount,
    purgedBytes: run.purgedBytes === null ? null : Number(run.purgedBytes),
    cancelledByEmail: run.cancelledByUser?.email ?? null,
    cancelledAt: run.cancelledAt?.toISOString() ?? null,
  };
}
