import { Injectable, Logger } from '@nestjs/common';
import type { AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  tenantId: string;
  action: AuditAction;
  userId?: string | null;
  recordingId?: string | null;
  detail?: Prisma.InputJsonValue;
  ip?: string | null;
}

/**
 * Seul écrivain du journal d'audit. Le journal est append-only : ce service
 * n'expose volontairement ni mise à jour ni suppression, et la base refuse
 * les deux (déclencheur `audit_events_append_only`).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          tenantId: entry.tenantId,
          userId: entry.userId ?? null,
          action: entry.action,
          recordingId: entry.recordingId ?? null,
          detail: entry.detail ?? undefined,
          ip: entry.ip ?? null,
        },
      });
    } catch (error) {
      // Une trace perdue est un incident : on la remonte bruyamment, sans
      // faire échouer l'action de l'utilisateur déjà réalisée.
      this.logger.error(
        `Échec d'écriture au journal d'audit (${entry.action}, locataire ${entry.tenantId})`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
