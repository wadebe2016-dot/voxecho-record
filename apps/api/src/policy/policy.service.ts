import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, RecordingPolicyVersion } from '@prisma/client';
import {
  parseRecordingPolicy,
  politiqueParDefaut,
  type PolicyVersionDetail,
  type PolicyVersionSummary,
  type RecordingPolicy,
} from '@voxecho/shared';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import type { PublishPolicyDto } from './dto/publish.dto';

/**
 * Référentiel de politiques d'enregistrement — CLAUDE.md §9.23.
 *
 * Un brouillon à la fois, des versions publiées immuables, et un numéro qui
 * croît. Ce numéro est la pièce maîtresse : c'est lui qui accompagnera chaque
 * décision de ne pas enregistrer, et qui permettra de produire, des mois plus
 * tard, la politique exacte qui s'appliquait.
 */
@Injectable()
export class PolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private readonly avecAuteurs = {
    auteur: { select: { email: true } },
    editeur: { select: { email: true } },
  } satisfies Prisma.RecordingPolicyVersionInclude;

  /** Empreinte du document : ce que le connecteur vérifiera (§9.23). */
  private empreinte(document: RecordingPolicy): string {
    return createHash('sha256').update(JSON.stringify(document)).digest('hex');
  }

  private versResume(
    ligne: RecordingPolicyVersion & {
      auteur: { email: string };
      editeur: { email: string } | null;
    },
  ): PolicyVersionSummary {
    const document = ligne.document as unknown as RecordingPolicy;
    return {
      id: ligne.id,
      version: ligne.version,
      status: ligne.status,
      note: ligne.note,
      sha256: ligne.sha256,
      createdByEmail: ligne.auteur.email,
      createdAt: ligne.createdAt.toISOString(),
      publishedByEmail: ligne.editeur?.email ?? null,
      publishedAt: ligne.publishedAt?.toISOString() ?? null,
      resume: {
        parDefaut: document.parDefaut,
        regles: document.regles.length,
        exclusions: document.exclusions.length,
        listes: document.listes.length,
      },
    };
  }

  private versDetail(
    ligne: RecordingPolicyVersion & {
      auteur: { email: string };
      editeur: { email: string } | null;
    },
  ): PolicyVersionDetail {
    return { ...this.versResume(ligne), document: ligne.document as unknown as RecordingPolicy };
  }

  /** Toutes les versions du locataire, la plus récente en tête. */
  async lister(tenantId: string): Promise<PolicyVersionSummary[]> {
    const lignes = await this.prisma.recordingPolicyVersion.findMany({
      where: { tenantId },
      orderBy: { version: 'desc' },
      include: this.avecAuteurs,
    });
    return lignes.map((ligne) => this.versResume(ligne));
  }

  /**
   * La politique en vigueur : la dernière publiée. Aucune n'ayant encore été
   * publiée, c'est le défaut du produit qui s'applique — tout est enregistré.
   * Ne pas enregistrer doit toujours résulter d'une décision écrite.
   */
  async enVigueur(tenantId: string): Promise<PolicyVersionDetail | null> {
    const ligne = await this.prisma.recordingPolicyVersion.findFirst({
      where: { tenantId, status: 'published' },
      orderBy: { version: 'desc' },
      include: this.avecAuteurs,
    });
    return ligne === null ? null : this.versDetail(ligne);
  }

  /** Le document qui s'applique réellement, publié ou défaut du produit. */
  async documentApplique(tenantId: string): Promise<RecordingPolicy> {
    return (await this.enVigueur(tenantId))?.document ?? politiqueParDefaut();
  }

  async brouillon(tenantId: string): Promise<PolicyVersionDetail | null> {
    const ligne = await this.prisma.recordingPolicyVersion.findFirst({
      where: { tenantId, status: 'draft' },
      include: this.avecAuteurs,
    });
    return ligne === null ? null : this.versDetail(ligne);
  }

  /**
   * Écrit le brouillon — créé s'il n'existe pas, remplacé sinon. Un seul
   * brouillon à la fois par locataire : deux versions en préparation
   * poseraient la question de savoir laquelle se publie, sans qu'aucun
   * administrateur ne l'ait demandée.
   */
  async enregistrerBrouillon(user: AuthUser, document: unknown): Promise<PolicyVersionDetail> {
    const valide = parseRecordingPolicy(document);
    if (!valide.ok) {
      throw new BadRequestException({
        message: 'Politique invalide.',
        details: valide.errors,
      });
    }

    const existant = await this.prisma.recordingPolicyVersion.findFirst({
      where: { tenantId: user.tenantId, status: 'draft' },
    });

    const ligne =
      existant === null
        ? await this.prisma.recordingPolicyVersion.create({
            data: {
              tenantId: user.tenantId,
              version: await this.prochaineVersion(user.tenantId),
              status: 'draft',
              document: valide.value as unknown as Prisma.InputJsonValue,
              createdBy: user.userId,
            },
            include: this.avecAuteurs,
          })
        : await this.prisma.recordingPolicyVersion.update({
            where: { id: existant.id },
            data: {
              document: valide.value as unknown as Prisma.InputJsonValue,
              createdBy: user.userId,
              createdAt: new Date(),
            },
            include: this.avecAuteurs,
          });

    // Un brouillon ne s'inscrit pas au journal : c'est un travail en cours,
    // sans effet sur la capture, comme la simulation de purge du §9.7. Ce qui
    // se trace, c'est la publication.
    return this.versDetail(ligne);
  }

  private async prochaineVersion(tenantId: string): Promise<number> {
    const derniere = await this.prisma.recordingPolicyVersion.findFirst({
      where: { tenantId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    return (derniere?.version ?? 0) + 1;
  }

  /** Abandonne le brouillon. Une version publiée, elle, ne s'efface jamais. */
  async abandonnerBrouillon(tenantId: string): Promise<void> {
    const existant = await this.prisma.recordingPolicyVersion.findFirst({
      where: { tenantId, status: 'draft' },
    });
    if (existant === null) throw new NotFoundException('Aucun brouillon à abandonner.');
    await this.prisma.recordingPolicyVersion.delete({ where: { id: existant.id } });
  }

  /**
   * Publie le brouillon. La version devient immuable — un déclencheur en base
   * l'y contraint — et opposable : c'est elle qui expliquera les appels
   * qu'on n'aura pas enregistrés.
   */
  async publier(
    user: AuthUser,
    dto: PublishPolicyDto,
    ip: string | null,
  ): Promise<PolicyVersionDetail> {
    const brouillon = await this.prisma.recordingPolicyVersion.findFirst({
      where: { tenantId: user.tenantId, status: 'draft' },
      include: this.avecAuteurs,
    });
    if (brouillon === null) throw new NotFoundException('Aucun brouillon à publier.');

    const document = brouillon.document as unknown as RecordingPolicy;
    const empreinte = this.empreinte(document);
    const precedente = await this.enVigueur(user.tenantId);

    if (precedente !== null && precedente.sha256 === empreinte) {
      // Publier une version identique empilerait des numéros sans changer
      // quoi que ce soit, et brouillerait la lecture d'un historique dont
      // toute la valeur est de dater les changements.
      throw new ConflictException(
        `Ce brouillon est identique à la version ${precedente.version} en vigueur : rien à publier.`,
      );
    }

    const publiee = await this.prisma.recordingPolicyVersion.update({
      where: { id: brouillon.id },
      data: {
        status: 'published',
        note: dto.note,
        sha256: empreinte,
        publishedBy: user.userId,
        publishedAt: new Date(),
      },
      include: this.avecAuteurs,
    });

    await this.audit.record({
      tenantId: user.tenantId,
      userId: user.userId,
      action: 'POLICY_SET',
      ip,
      detail: {
        version: publiee.version,
        versionPrecedente: precedente?.version ?? null,
        note: dto.note,
        sha256: empreinte,
        parDefaut: document.parDefaut,
        regles: document.regles.length,
        exclusions: document.exclusions.length,
        // Ce qui compte pour un contrôleur : cette version renonce-t-elle à
        // des enregistrements, et lesquels ?
        renonce:
          document.parDefaut !== 'always' ||
          document.exclusions.length > 0 ||
          document.regles.some((regle) => regle.decision !== 'always'),
      },
    });

    return this.versDetail(publiee);
  }
}
