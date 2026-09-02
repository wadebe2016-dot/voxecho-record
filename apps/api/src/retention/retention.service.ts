import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  RETENTION_DAYS_DEFAULT,
  RETENTION_SCOPE_ALL,
  type RetentionPolicyResponse,
} from '@voxecho/shared';
import { AuditService } from '../audit/audit.service';
import { AppConfig } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { SetRetentionDto } from './dto/set-retention.dto';

@Injectable()
export class RetentionService {
  private readonly plancher: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    config: AppConfig,
  ) {
    this.plancher = config.get('RETENTION_MIN_DAYS');
  }

  /** Le plancher de l'instance, que le portail affiche avant de laisser saisir. */
  get plancherJours(): number {
    return this.plancher;
  }

  /**
   * Politique en vigueur. Un locataire sans politique enregistrée n'est pas
   * un locataire sans rétention : c'est le défaut du produit qui s'applique,
   * et il est rendu tel quel plutôt que sous forme de vide à interpréter.
   */
  async lire(tenantId: string): Promise<RetentionPolicyResponse> {
    const policy = await this.prisma.retentionPolicy.findUnique({
      where: { tenantId_appliesTo: { tenantId, appliesTo: RETENTION_SCOPE_ALL } },
    });

    return {
      days: policy?.days ?? RETENTION_DAYS_DEFAULT,
      appliesTo: RETENTION_SCOPE_ALL,
      belowFloorReason: policy?.belowFloorReason ?? null,
      minDays: this.plancher,
      updatedAt: (policy?.updatedAt ?? new Date(0)).toISOString(),
    };
  }

  /**
   * Change la durée de conservation. Descendre sous le plancher de l'instance
   * exige un motif écrit — c'est la seule chose qui distingue une dérogation
   * assumée d'une purge anticipée dont personne ne se souviendra.
   *
   * Le motif est exigé **uniquement** en dessous du plancher : réclamer une
   * justification pour allonger une conservation ferait de la prudence une
   * corvée, et la prudence n'a pas à se justifier ici.
   */
  async definir(
    user: AuthUser,
    dto: SetRetentionDto,
    ip: string | null,
  ): Promise<RetentionPolicyResponse> {
    const sousLePlancher = dto.days < this.plancher;
    const motif = dto.belowFloorReason?.trim() ?? '';

    if (sousLePlancher && motif === '') {
      throw new BadRequestException(
        `Une conservation de ${dto.days} jours passe sous le plancher de ${this.plancher} jours : un motif écrit est exigé.`,
      );
    }
    if (!sousLePlancher && motif !== '') {
      // Un motif de dérogation attaché à une politique qui ne déroge à rien
      // laisserait croire à un contrôleur qu'il en lit une.
      throw new BadRequestException(
        'Aucune dérogation n’est nécessaire au-dessus du plancher : le motif est refusé.',
      );
    }

    const avant = await this.lire(user.tenantId);
    const apres = await this.prisma.retentionPolicy.upsert({
      where: {
        tenantId_appliesTo: { tenantId: user.tenantId, appliesTo: RETENTION_SCOPE_ALL },
      },
      update: { days: dto.days, belowFloorReason: sousLePlancher ? motif : null },
      create: {
        tenantId: user.tenantId,
        appliesTo: RETENTION_SCOPE_ALL,
        days: dto.days,
        belowFloorReason: sousLePlancher ? motif : null,
      },
    });

    await this.audit.record({
      tenantId: user.tenantId,
      userId: user.userId,
      action: 'RETENTION_SET',
      ip,
      detail: {
        // L'ancienne valeur autant que la nouvelle : « passé de 730 à 90 »
        // se lit, « mis à 90 » se devine.
        avantJours: avant.days,
        apresJours: apres.days,
        plancherJours: this.plancher,
        sousLePlancher,
        ...(sousLePlancher ? { motifDerogation: motif } : {}),
        // Raccourcir met des preuves en file d'attente pour la destruction.
        raccourcie: apres.days < avant.days,
      },
    });

    return {
      days: apres.days,
      appliesTo: apres.appliesTo,
      belowFloorReason: apres.belowFloorReason,
      minDays: this.plancher,
      updatedAt: apres.updatedAt.toISOString(),
    };
  }

  /**
   * Date d'échéance d'un enregistrement au regard de la politique en vigueur.
   * Utilisé par la purge (lot 02) et par la fiche d'appel : un auditeur doit
   * pouvoir répondre à « jusqu'à quand cet appel est-il conservé ? ».
   */
  async echeance(tenantId: string, startedAt: Date): Promise<Date> {
    const { days } = await this.lire(tenantId);
    const echeance = new Date(startedAt);
    echeance.setUTCDate(echeance.getUTCDate() + days);
    return echeance;
  }

  /** Garde-fou partagé : l'enregistrement existe-t-il chez ce locataire ? */
  async exigerEnregistrement(tenantId: string, recordingId: string): Promise<{ id: string }> {
    const recording = await this.prisma.recording.findFirst({
      where: { id: recordingId, tenantId },
      select: { id: true },
    });
    if (!recording) throw new NotFoundException('Enregistrement introuvable.');
    return recording;
  }
}
