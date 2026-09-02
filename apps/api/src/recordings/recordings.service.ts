import { Injectable } from '@nestjs/common';
import type { Recording } from '@prisma/client';
import type { Page, RecordingListItem } from '@voxecho/shared';
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
   * consultation est tracée : le journal doit pouvoir répondre à « qui a
   * cherché quoi, et quand ».
   */
  async list(
    user: AuthUser,
    query: ListRecordingsDto,
    ip: string | null,
  ): Promise<Page<RecordingListItem>> {
    const where = { tenantId: user.tenantId };

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
