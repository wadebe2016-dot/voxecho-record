import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  dayRangeToInstants,
  type AuditEventItem,
  type AuditScope,
  type Page,
} from '@voxecho/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { AuditService } from './audit.service';
import { ListAuditDto } from './dto/list-audit.dto';

/** Au-delà, un export CSV n'est plus une pièce, c'est un déversement. */
export const AUDIT_CSV_MAX_LIGNES = 50_000;

/**
 * Lecture du journal d'audit — CLAUDE.md §6 et §9.11.
 *
 * Service distinct de `AuditService`, qui écrit : le journal est append-only,
 * et rien ici ne doit pouvoir devenir une écriture par accident.
 */
@Injectable()
export class AuditReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(user: AuthUser, query: ListAuditDto): Promise<Page<AuditEventItem>> {
    const where = this.construireFiltre(user, query);

    const [total, rows] = await this.prisma.$transaction([
      this.prisma.auditEvent.count({ where }),
      this.prisma.auditEvent.findMany({
        where,
        // Le plus récent en tête : un contrôleur commence par « que s'est-il
        // passé récemment », pas par la genèse de l'instance.
        orderBy: { at: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: this.jointures,
      }),
    ]);

    return {
      items: rows.map(versItem),
      total,
      page: query.page,
      pageSize: query.pageSize,
      pageCount: total === 0 ? 0 : Math.ceil(total / query.pageSize),
    };
  }

  /**
   * Journal filtré au format CSV. Contrairement à la lecture à l'écran,
   * l'export **est** tracé : un extrait du journal qui sort du produit est
   * une pièce, et une pièce se sait sortie (§9.11).
   */
  async exporterCsv(
    user: AuthUser,
    query: ListAuditDto,
    ip: string | null,
  ): Promise<{ csv: string; lignes: number; tronque: boolean }> {
    const where = this.construireFiltre(user, query);
    const total = await this.prisma.auditEvent.count({ where });
    const rows = await this.prisma.auditEvent.findMany({
      where,
      orderBy: { at: 'desc' },
      take: AUDIT_CSV_MAX_LIGNES,
      include: this.jointures,
    });

    const tronque = total > rows.length;
    const csv = versCsv(rows.map(versItem));

    await this.audit.record({
      tenantId: user.tenantId,
      userId: user.userId,
      action: 'EXPORT',
      ip,
      detail: {
        objet: 'journal-audit',
        lignes: rows.length,
        totalCorrespondant: total,
        tronque,
        ...critereTrace(query),
      },
    });

    return { csv, lignes: rows.length, tronque };
  }

  /**
   * Périmètre et filtres. Le `tenantId` du jeton borne la lecture ; seuls les
   * événements système peuvent l'élargir, et seulement pour un ADMIN.
   */
  private construireFiltre(user: AuthUser, query: ListAuditDto): Prisma.AuditEventWhereInput {
    const scope: AuditScope = query.scope ?? 'tenant';
    // Les événements qu'aucun locataire ne réclame (§9.2) relèvent de
    // l'instance, pas d'un ADMIN de locataire : le §9.22 sépare les deux.
    if (scope !== 'tenant' && !user.instanceAdmin) {
      // Les dépôts qu'aucun locataire ne réclame ne regardent que
      // l'administrateur de l'instance (§9.2).
      throw new ForbiddenException(
        'Les événements système ne sont lisibles que par un administrateur de l’instance.',
      );
    }

    const where: Prisma.AuditEventWhereInput = {};

    if (scope === 'tenant') where.tenantId = user.tenantId;
    else if (scope === 'system') where.tenantId = null;
    else where.OR = [{ tenantId: user.tenantId }, { tenantId: null }];

    if (query.action) where.action = query.action;
    if (query.recordingId) where.recordingId = query.recordingId;
    if (query.actor) {
      where.user = { email: { contains: query.actor, mode: 'insensitive' } };
    }
    if (query.from ?? query.to) {
      where.at = dayRangeToInstants(query.from, query.to);
    }

    return where;
  }

  private readonly jointures = {
    user: { select: { email: true } },
    recording: { select: { refci: true } },
  } as const;
}

type LigneJournal = {
  id: string;
  at: Date;
  action: AuditEventItem['action'];
  tenantId: string | null;
  recordingId: string | null;
  ip: string | null;
  detail: unknown;
  user: { email: string } | null;
  recording: { refci: string } | null;
};

function versItem(row: LigneJournal): AuditEventItem {
  return {
    id: row.id,
    at: row.at.toISOString(),
    action: row.action,
    actorEmail: row.user?.email ?? null,
    tenantId: row.tenantId,
    recordingId: row.recordingId,
    recordingRefci: row.recording?.refci ?? null,
    ip: row.ip,
    detail: (row.detail as Record<string, unknown> | null) ?? null,
  };
}

/** Critères effectivement appliqués, pour la trace de l'export. */
function critereTrace(query: ListAuditDto): Record<string, unknown> {
  const criteres: Record<string, unknown> = {};
  if (query.action) criteres.action = query.action;
  if (query.actor) criteres.auteur = query.actor;
  if (query.recordingId) criteres.enregistrement = query.recordingId;
  if (query.from) criteres.du = query.from;
  if (query.to) criteres.au = query.to;
  if (query.scope) criteres.perimetre = query.scope;
  return Object.keys(criteres).length > 0 ? { criteres } : {};
}

const COLONNES = [
  'horodatage_utc',
  'action',
  'auteur',
  'adresse_ip',
  'enregistrement_refci',
  'enregistrement_id',
  'locataire_id',
  'detail',
] as const;

/**
 * CSV destiné à un tableur de bureau. Séparateur point-virgule et marque
 * d'ordre d'octets en tête : sans elles, Excel en configuration française
 * ouvre le fichier en une seule colonne et massacre les accents. Un journal
 * illisible ne prouve rien.
 */
export function versCsv(items: AuditEventItem[]): string {
  const lignes = [COLONNES.join(';')];
  for (const item of items) {
    lignes.push(
      [
        item.at,
        item.action,
        item.actorEmail ?? '',
        item.ip ?? '',
        item.recordingRefci ?? '',
        item.recordingId ?? '',
        item.tenantId ?? '',
        item.detail === null ? '' : JSON.stringify(item.detail),
      ]
        .map(echapper)
        .join(';'),
    );
  }
  // \uFEFF écrit en échappement : le caractère lui-même, invisible dans le
  // code, se perd au premier copier-coller.
  return `\uFEFF${lignes.join('\r\n')}\r\n`;
}

/**
 * Échappement CSV. Le guillemet doublé et l'encadrement sont la règle ; le
 * préfixe sur `=`, `+`, `-` et `@` protège d'une formule injectée par un
 * champ libre — un motif de conservation forcée, par exemple, est saisi par
 * un humain et finira dans un tableur.
 */
function echapper(valeur: string): string {
  const sur = /^[=+\-@]/.test(valeur) ? `'${valeur}` : valeur;
  return `"${sur.replace(/"/g, '""')}"`;
}
