import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  BadRequestException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, Recording } from '@prisma/client';
import {
  dayRangeToInstants,
  type ListenTicketResponse,
  type Page,
  type RecordingListItem,
} from '@voxecho/shared';
import { AuditService } from '../audit/audit.service';
import { resoudreCheminDeDonnees } from '../config/chemins';
import { AppConfig } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import { LegalHoldsService } from '../retention/legal-holds.service';
import type { AuthUser } from '../auth/auth.types';
import { ListRecordingsDto } from './dto/list-recordings.dto';
import { ListenTicketService, type ListenTicket } from './listen-ticket.service';

/** Fichier prêt à être servi, mesuré : la taille commande les plages. */
export interface FluxAudio {
  chemin: string;
  taille: number;
  nomFichier: string;
}

@Injectable()
export class RecordingsService {
  private readonly logger = new Logger(RecordingsService.name);
  private readonly storageDir: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly billets: ListenTicketService,
    private readonly holds: LegalHoldsService,
    config: AppConfig,
  ) {
    this.storageDir = resoudreCheminDeDonnees(config.get('STORAGE_DIR'));
  }

  /**
   * Liste paginée, toujours restreinte au locataire du jeton. Chaque
   * consultation est tracée avec ses filtres : le journal doit pouvoir
   * répondre à « qui a cherché quoi, et quand ».
   */
  async list(
    user: AuthUser,
    query: ListRecordingsDto,
    ip: string | null,
  ): Promise<Page<RecordingListItem>> {
    const where = this.construireFiltre(user.tenantId, query);

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.recording.count({ where }),
      this.prisma.recording.findMany({
        where,
        orderBy: { [query.sort]: query.order },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);

    await this.audit.record({
      tenantId: user.tenantId,
      userId: user.userId,
      action: 'SEARCH',
      ip,
      detail: {
        page: query.page,
        pageSize: query.pageSize,
        sort: query.sort,
        order: query.order,
        resultats: total,
        // Les critères sont consignés tels que saisis : une recherche sans
        // ses critères ne prouve rien de ce que l'auditeur a consulté.
        ...critereTrace(query),
      },
    });

    // Un seul aller-retour pour toute la page : marquer chaque ligne
    // séparément ferait vingt-cinq requêtes pour vingt-cinq appels.
    const sousHold = await this.holds.idsSousHold(
      user.tenantId,
      rows.map((row) => row.id),
    );

    return {
      items: rows.map((row) => versListItem(row, sousHold.has(row.id))),
      total,
      page: query.page,
      pageSize: query.pageSize,
      pageCount: total === 0 ? 0 : Math.ceil(total / query.pageSize),
    };
  }

  /**
   * Ouvre une écoute — CLAUDE.md §6. C'est **ici** que le journal enregistre
   * la consultation, une fois, pour l'acte de l'auditeur : le lecteur enverra
   * ensuite autant de requêtes `Range` qu'il lui faut, et aucune ne sera
   * tracée. Une écoute au journal correspond donc à un auditeur qui a demandé
   * à entendre un appel, pas à un aléa de mise en mémoire tampon.
   */
  async ouvrirEcoute(
    user: AuthUser,
    recordingId: string,
    ip: string | null,
  ): Promise<ListenTicketResponse> {
    const recording = await this.prisma.recording.findFirst({
      where: { id: recordingId, tenantId: user.tenantId },
      select: { id: true, status: true, sha256: true, durationSec: true, refci: true },
    });
    // Introuvable et « appartient à un autre locataire » se répondent
    // pareil : une réponse distincte confirmerait l'existence de l'appel.
    if (!recording) throw new NotFoundException('Enregistrement introuvable.');
    if (recording.status === 'purged') {
      throw new GoneException('Enregistrement purgé : l’audio n’existe plus.');
    }

    await this.audit.record({
      tenantId: user.tenantId,
      userId: user.userId,
      action: 'LISTEN',
      recordingId: recording.id,
      ip,
      detail: {
        refci: recording.refci,
        sha256: recording.sha256,
        durationSec: recording.durationSec,
      },
    });

    return this.billets.issue({
      userId: user.userId,
      tenantId: user.tenantId,
      recordingId: recording.id,
    });
  }

  /**
   * Localise le fichier d'un enregistrement pour le billet présenté. Le
   * cloisonnement est revérifié ici : un billet ne dispense pas de vérifier
   * que l'appel est bien celui d'un locataire du porteur.
   */
  async ouvrirFlux(billet: ListenTicket): Promise<FluxAudio> {
    const recording = await this.prisma.recording.findFirst({
      where: { id: billet.recordingId, tenantId: billet.tenantId },
      select: { filePath: true, status: true },
    });
    if (!recording) throw new NotFoundException('Enregistrement introuvable.');
    if (recording.status === 'purged') {
      throw new GoneException('Enregistrement purgé : l’audio n’existe plus.');
    }

    const chemin = resolve(join(this.storageDir, recording.filePath));
    // Le chemin vient de la base, donc de l'ingestion — mais une preuve ne se
    // sert que depuis son coffre, et cela se vérifie plutôt que cela ne se
    // suppose.
    if (chemin !== this.storageDir && !chemin.startsWith(this.storageDir + sep)) {
      this.logger.error(`Chemin hors STORAGE_DIR refusé : ${recording.filePath}`);
      throw new NotFoundException('Enregistrement introuvable.');
    }

    let taille: number;
    try {
      taille = (await stat(chemin)).size;
    } catch {
      // La base connaît l'appel, le disque ne l'a plus : c'est un incident
      // d'intégrité, pas une requête malformée. On le dit haut et fort.
      this.logger.error(`Fichier absent du stockage : ${recording.filePath}`);
      throw new NotFoundException('Fichier audio introuvable dans le stockage.');
    }

    return { chemin, taille, nomFichier: recording.filePath.split('/').pop() ?? 'appel.wav' };
  }

  /**
   * Le `tenantId` du jeton ouvre le filtre et rien ne peut l'élargir : les
   * critères s'ajoutent en `AND`, jamais en `OR`, pour qu'aucune combinaison
   * de filtres ne puisse faire sortir un appel d'un autre locataire.
   */
  private construireFiltre(tenantId: string, query: ListRecordingsDto): Prisma.RecordingWhereInput {
    const where: Prisma.RecordingWhereInput = { tenantId };

    if (query.phone) {
      // Le numéro cherché peut être d'un côté comme de l'autre de l'appel.
      where.OR = [
        { near: { contains: query.phone, mode: 'insensitive' } },
        { far: { contains: query.phone, mode: 'insensitive' } },
      ];
    }

    if (query.from ?? query.to) {
      if (query.from && query.to && query.from > query.to) {
        throw new BadRequestException('La date de début est postérieure à la date de fin.');
      }
      where.startedAt = dayRangeToInstants(query.from, query.to);
    }

    if (query.direction) where.direction = query.direction;

    if (query.category) where.operationCategory = query.category;

    if (query.minDurationSec !== undefined || query.maxDurationSec !== undefined) {
      const min = query.minDurationSec;
      const max = query.maxDurationSec;
      if (min !== undefined && max !== undefined && min > max) {
        throw new BadRequestException('La durée minimale dépasse la durée maximale.');
      }
      where.durationSec = {
        ...(min !== undefined ? { gte: min } : {}),
        ...(max !== undefined ? { lte: max } : {}),
      };
    }

    return where;
  }
}

/** Critères effectivement appliqués, pour le journal d'audit. */
function critereTrace(query: ListRecordingsDto): Record<string, unknown> {
  const criteres: Record<string, unknown> = {};
  if (query.phone) criteres.numero = query.phone;
  if (query.from) criteres.du = query.from;
  if (query.to) criteres.au = query.to;
  if (query.direction) criteres.sens = query.direction;
  if (query.category) criteres.categorie = query.category;
  if (query.minDurationSec !== undefined) criteres.dureeMin = query.minDurationSec;
  if (query.maxDurationSec !== undefined) criteres.dureeMax = query.maxDurationSec;
  return Object.keys(criteres).length > 0 ? { criteres } : {};
}

/**
 * Le portail reçoit des types JSON simples : `sizeBytes` est un BigInt en
 * base (un fichier peut dépasser l'entier signé 32 bits) mais tient
 * largement dans un nombre JavaScript exact.
 */
function versListItem(row: Recording, underHold: boolean): RecordingListItem {
  return {
    id: row.id,
    refci: row.refci,
    near: row.near,
    far: row.far,
    direction: row.direction,
    startedAt: row.startedAt.toISOString(),
    durationSec: row.durationSec,
    sha256: row.sha256,
    sizeBytes: Number(row.sizeBytes),
    source: row.source === 'cucm_bib' ? 'cucm-bib' : row.source,
    status: row.status,
    operationCategory: row.operationCategory as RecordingListItem['operationCategory'],
    underHold,
  };
}
