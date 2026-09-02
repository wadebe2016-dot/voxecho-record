import { BadRequestException, Injectable } from '@nestjs/common';
import type { Prisma, Recording } from '@prisma/client';
import { dayRangeToInstants, type Page, type RecordingListItem } from '@voxecho/shared';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { ListRecordingsDto } from './dto/list-recordings.dto';

@Injectable()
export class RecordingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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

    return {
      items: rows.map(versListItem),
      total,
      page: query.page,
      pageSize: query.pageSize,
      pageCount: total === 0 ? 0 : Math.ceil(total / query.pageSize),
    };
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
  if (query.minDurationSec !== undefined) criteres.dureeMin = query.minDurationSec;
  if (query.maxDurationSec !== undefined) criteres.dureeMax = query.maxDurationSec;
  return Object.keys(criteres).length > 0 ? { criteres } : {};
}

/**
 * Le portail reçoit des types JSON simples : `sizeBytes` est un BigInt en
 * base (un fichier peut dépasser l'entier signé 32 bits) mais tient
 * largement dans un nombre JavaScript exact.
 */
function versListItem(row: Recording): RecordingListItem {
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
  };
}
