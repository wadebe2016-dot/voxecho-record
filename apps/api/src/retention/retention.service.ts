import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  INGEST_OPERATION_CATEGORIES,
  RETENTION_DAYS_DEFAULT,
  RETENTION_SCOPE_ALL,
  type RetentionPolicyEntry,
  type RetentionPolicyResponse,
  type RetentionPolicySetResponse,
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

  /** Périmètres acceptés : le général, et une catégorie d'opération (§9.28). */
  private exigerPerimetre(appliesTo: string): string {
    if (appliesTo === RETENTION_SCOPE_ALL) return appliesTo;
    if ((INGEST_OPERATION_CATEGORIES as readonly string[]).includes(appliesTo)) return appliesTo;
    // Même règle qu'au §9.10 : une catégorie que personne n'a déclarée est une
    // faute de frappe, et l'accepter créerait un catalogue par accident.
    throw new BadRequestException(
      `Périmètre inconnu : « ${RETENTION_SCOPE_ALL} » ou une catégorie d'opération (${INGEST_OPERATION_CATEGORIES.join(', ')}).`,
    );
  }

  /**
   * Toutes les politiques du locataire — CLAUDE.md §9.28.
   *
   * Une catégorie sans politique propre n'est pas une catégorie sans
   * conservation : elle suit la générale, et c'est dit plutôt que laissé à
   * deviner.
   */
  async lireEnsemble(tenantId: string): Promise<RetentionPolicySetResponse> {
    const lignes = await this.prisma.retentionPolicy.findMany({ where: { tenantId } });
    const parPerimetre = new Map(lignes.map((ligne) => [ligne.appliesTo, ligne]));

    const entree = (appliesTo: string): RetentionPolicyEntry => {
      const ligne = parPerimetre.get(appliesTo);
      const generale = parPerimetre.get(RETENTION_SCOPE_ALL);
      return {
        appliesTo,
        days: ligne?.days ?? generale?.days ?? RETENTION_DAYS_DEFAULT,
        belowFloorReason: ligne?.belowFloorReason ?? null,
        updatedAt: (ligne?.updatedAt ?? new Date(0)).toISOString(),
        enregistree: ligne !== undefined,
      };
    };

    return {
      generale: entree(RETENTION_SCOPE_ALL),
      parCategorie: INGEST_OPERATION_CATEGORIES.map((categorie) => entree(categorie)),
      minDays: this.plancher,
    };
  }

  /**
   * Durée applicable à un appel — la politique de sa catégorie si elle
   * existe, la générale sinon.
   *
   * **La plus précise l'emporte, et non la plus longue.** Le §9.10 laissait les
   * deux ouvertes ; retenir la plus longue rendrait toute politique de
   * catégorie incapable de raccourcir, alors que c'est précisément l'usage
   * attendu — conserver dix ans les ordres de change et deux ans le reste
   * suppose de pouvoir faire les deux. Ce qui protège contre un
   * raccourcissement discret n'est pas cette règle mais le plancher de
   * l'instance, qui exige un motif écrit sous son seuil (§9.6).
   */
  async joursApplicables(tenantId: string, categorie: string | null): Promise<number> {
    const ensemble = await this.lireEnsemble(tenantId);
    if (categorie === null) return ensemble.generale.days;
    const propre = ensemble.parCategorie.find(
      (entree) => entree.appliesTo === categorie && entree.enregistree,
    );
    return propre?.days ?? ensemble.generale.days;
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

    const perimetre = this.exigerPerimetre(dto.appliesTo ?? RETENTION_SCOPE_ALL);
    const ensembleAvant = await this.lireEnsemble(user.tenantId);
    const avant =
      perimetre === RETENTION_SCOPE_ALL
        ? ensembleAvant.generale
        : (ensembleAvant.parCategorie.find((entree) => entree.appliesTo === perimetre) ??
          ensembleAvant.generale);

    const apres = await this.prisma.retentionPolicy.upsert({
      where: {
        tenantId_appliesTo: { tenantId: user.tenantId, appliesTo: perimetre },
      },
      update: { days: dto.days, belowFloorReason: sousLePlancher ? motif : null },
      create: {
        tenantId: user.tenantId,
        appliesTo: perimetre,
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
        perimetre,
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
  async echeance(
    tenantId: string,
    startedAt: Date,
    categorie: string | null = null,
  ): Promise<Date> {
    const days = await this.joursApplicables(tenantId, categorie);
    return this.echeanceDepuis(startedAt, days);
  }

  /** Échéance d'un appel pour une durée donnée, sans relire la politique. */
  echeanceDepuis(startedAt: Date, days: number): Date {
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
