import { Injectable, Logger } from '@nestjs/common';
import type { AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  /**
   * Nul pour un événement que l'instance ne peut rattacher à aucun locataire :
   * un dépôt d'ingestion tombé dans un sous-répertoire inconnu ou désactivé.
   * Tout le reste porte son locataire.
   */
  tenantId: string | null;
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

  /**
   * Inscrit un événement.
   *
   * Sans `tx`, l'écriture est au mieux : l'acte de l'utilisateur a déjà eu
   * lieu, et une trace perdue se remonte bruyamment plutôt que de le faire
   * échouer après coup.
   *
   * Avec `tx`, l'écriture appartient à la transaction de l'appelant et son
   * échec la fait échouer. C'est ce qu'exige un acte dont la trace ne doit pas
   * pouvoir manquer : une purge exécutée sans son événement au journal serait
   * une destruction dont il ne resterait rien de lisible (§9.34).
   */
  async record(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    if (tx) {
      await this.ecrire(tx, entry);
      return;
    }
    try {
      await this.ecrire(this.prisma, entry);
    } catch (error) {
      // Une trace perdue est un incident : on la remonte bruyamment, sans
      // faire échouer l'action de l'utilisateur déjà réalisée.
      this.logger.error(
        `Échec d'écriture au journal d'audit (${entry.action}, locataire ${entry.tenantId ?? 'système'})`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** Le seul endroit du produit où une ligne de journal s'écrit. */
  private async ecrire(
    client: Prisma.TransactionClient | PrismaService,
    entry: AuditEntry,
  ): Promise<void> {
    await client.auditEvent.create({
      data: {
        tenantId: entry.tenantId ?? null,
        userId: entry.userId ?? null,
        action: entry.action,
        recordingId: entry.recordingId ?? null,
        detail: entry.detail ?? undefined,
        ip: entry.ip ?? null,
      },
    });
  }
}
