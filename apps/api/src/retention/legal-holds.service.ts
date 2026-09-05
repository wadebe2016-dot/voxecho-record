import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { LegalHold } from '@prisma/client';
import type { LegalHoldResponse } from '@voxecho/shared';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { RetentionService } from './retention.service';
import type { ReleaseHoldDto, SetHoldDto } from './dto/hold-reason.dto';

/** Un hold actif est une ligne non levée. Il n'y en a jamais deux à la fois. */
type HoldAvecComptes = LegalHold & {
  setByUser: { email: string };
  releasedByUser: { email: string } | null;
};

@Injectable()
export class LegalHoldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly retention: RetentionService,
  ) {}

  /**
   * Pose une conservation forcée. Le hold est la seule chose qui tienne tête à
   * la rétention : tant qu'il est actif, aucune purge ne touche cet appel,
   * quelle que soit son ancienneté.
   */
  async poser(
    user: AuthUser,
    recordingId: string,
    dto: SetHoldDto,
    ip: string | null,
  ): Promise<LegalHoldResponse> {
    await this.retention.exigerEnregistrement(user.tenantId, recordingId);

    const actif = await this.holdActif(user.tenantId, recordingId);
    if (actif) {
      // Empiler deux holds sur un appel donnerait deux motifs pour une seule
      // conservation, et une levée qui n'en libère qu'un.
      throw new ConflictException('Cet enregistrement est déjà sous conservation forcée.');
    }

    const hold = await this.prisma.legalHold.create({
      data: {
        tenantId: user.tenantId,
        recordingId,
        setBy: user.userId,
        reason: dto.reason.trim(),
        caseReference: dto.caseReference.trim(),
      },
      include: { setByUser: { select: { email: true } }, releasedByUser: false },
    });

    await this.audit.record({
      tenantId: user.tenantId,
      userId: user.userId,
      action: 'HOLD_SET',
      recordingId,
      ip,
      detail: { motif: hold.reason, dossier: hold.caseReference, holdId: hold.id },
    });

    return versReponse({ ...hold, releasedByUser: null });
  }

  /**
   * Lève la conservation forcée. L'appel redevient purgeable : c'est un acte
   * de destruction différée, et il se motive comme tel.
   */
  async lever(
    user: AuthUser,
    recordingId: string,
    dto: ReleaseHoldDto,
    ip: string | null,
  ): Promise<LegalHoldResponse> {
    await this.retention.exigerEnregistrement(user.tenantId, recordingId);

    const actif = await this.holdActif(user.tenantId, recordingId);
    if (!actif) {
      throw new NotFoundException('Cet enregistrement n’est pas sous conservation forcée.');
    }

    const seul = await this.contreValidation(user, actif, dto);

    const hold = await this.prisma.legalHold.update({
      where: { id: actif.id },
      data: {
        releasedAt: new Date(),
        releasedBy: user.userId,
        releaseReason: dto.reason.trim(),
        releasedWithoutSecondApproval: seul,
      },
      include: {
        setByUser: { select: { email: true } },
        releasedByUser: { select: { email: true } },
      },
    });

    await this.audit.record({
      tenantId: user.tenantId,
      userId: user.userId,
      action: 'HOLD_RELEASE',
      recordingId,
      ip,
      detail: {
        motif: hold.releaseReason,
        holdId: hold.id,
        dossier: hold.caseReference,
        poseePar: hold.setByUser.email,
        // Ce qu'un contrôleur cherchera d'abord : la levée a-t-elle été
        // contre-validée par quelqu'un d'autre que celui qui l'avait posée ?
        ...(seul
          ? { contreValidation: 'levée sans contre-validation' }
          : { contreValidation: 'second administrateur' }),
        // Le motif d'origine est rappelé : lire la levée sans savoir ce qu'on
        // levait obligerait à remonter le journal.
        motifPose: hold.reason,
        poseeLe: hold.at.toISOString(),
      },
    });

    return versReponse(hold);
  }

  /**
   * Contre-validation d'une levée — CLAUDE.md §9.29.
   *
   * Lever une conservation forcée rend l'appel purgeable : c'est une
   * destruction différée, et elle ne doit pas dépendre d'une seule personne —
   * surtout pas de celle qui l'avait posée, qui pourrait défaire seule ce
   * qu'elle a seule décidé.
   *
   * L'exception est assumée : une instance qui n'a qu'un administrateur actif
   * ne peut pas se retrouver dans l'impossibilité de lever une conservation
   * devenue sans objet. La levée passe alors, mais le fait est consigné —
   * empêcher aurait créé un blocage sans issue, taire aurait effacé la
   * différence entre deux niveaux de garantie.
   *
   * Rend `true` quand la levée se fait sans contre-validation.
   */
  private async contreValidation(
    user: AuthUser,
    actif: LegalHold,
    dto: ReleaseHoldDto,
  ): Promise<boolean> {
    if (actif.setBy !== user.userId) return false;

    const autres = await this.prisma.user.count({
      where: {
        tenantId: user.tenantId,
        role: 'ADMIN',
        active: true,
        id: { not: user.userId },
      },
    });

    if (autres > 0) {
      throw new BadRequestException(
        'Cette conservation a été posée par vous : sa levée doit être demandée par un autre administrateur.',
      );
    }
    if (dto.acceptSansContreValidation !== true) {
      throw new BadRequestException(
        'Aucun autre administrateur actif : la levée est possible sans contre-validation, mais elle doit être acceptée explicitement et sera consignée comme telle.',
      );
    }
    return true;
  }

  /** Historique des conservations d'un appel, la plus récente en tête. */
  async historique(tenantId: string, recordingId: string): Promise<LegalHoldResponse[]> {
    await this.retention.exigerEnregistrement(tenantId, recordingId);
    const holds = await this.prisma.legalHold.findMany({
      where: { tenantId, recordingId },
      orderBy: { at: 'desc' },
      include: {
        setByUser: { select: { email: true } },
        releasedByUser: { select: { email: true } },
      },
    });
    return holds.map(versReponse);
  }

  /**
   * Identifiants des appels d'un locataire sous conservation forcée. La purge
   * et la liste s'en servent — c'est la source unique, `Recording.status` n'en
   * porte aucune copie (CLAUDE.md §9.6).
   */
  async idsSousHold(tenantId: string, parmi?: string[]): Promise<Set<string>> {
    const holds = await this.prisma.legalHold.findMany({
      where: {
        tenantId,
        releasedAt: null,
        ...(parmi ? { recordingId: { in: parmi } } : {}),
      },
      select: { recordingId: true },
    });
    return new Set(holds.map((hold) => hold.recordingId));
  }

  private async holdActif(tenantId: string, recordingId: string): Promise<LegalHold | null> {
    return this.prisma.legalHold.findFirst({
      where: { tenantId, recordingId, releasedAt: null },
    });
  }
}

function versReponse(hold: HoldAvecComptes): LegalHoldResponse {
  return {
    id: hold.id,
    recordingId: hold.recordingId,
    reason: hold.reason,
    caseReference: hold.caseReference,
    setByEmail: hold.setByUser.email,
    at: hold.at.toISOString(),
    releasedAt: hold.releasedAt?.toISOString() ?? null,
    releasedByEmail: hold.releasedByUser?.email ?? null,
    releaseReason: hold.releaseReason,
    releasedWithoutSecondApproval: hold.releasedWithoutSecondApproval,
  };
}
