import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Page, PurgeReportDetail, PurgeReportSummary } from '@voxecho/shared';
import { AuditService } from '../audit/audit.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthUser } from '../auth/auth.types';
import { ExecutePurgeDto } from './dto/execute-purge.dto';
import { ListReportsDto } from './dto/list-reports.dto';
import { ReadReportDto } from './dto/read-report.dto';
import { PurgeService } from './purge.service';
import { CertificatService } from './certificat.service';
import { construireCertificatCsv } from './certificat-csv';
import { construireCertificatPdf } from './certificat-pdf';

/**
 * Purge — CLAUDE.md §5 et §9.7.
 *
 * Aucune purge automatique : le produit énumère, un responsable conformité
 * valide, un ADMIN exécute. Le rapport est l'autorisation.
 */
@Controller('purge/reports')
export class PurgeController {
  constructor(
    private readonly purge: PurgeService,
    private readonly certificats: CertificatService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Certificat de destruction — CLAUDE.md §9.31.
   *
   * Ouvert aux trois rôles : c'est une pièce de conformité, et un auditeur
   * doit pouvoir la produire sans demander à l'exploitant. Elle ne contient
   * aucun audio — seulement ce qui reste de ce qui a été détruit.
   */
  @Roles('ADMIN', 'SUPERVISOR', 'AUDITOR')
  @Get(':id/certificat')
  async certificat(
    @Param('id') id: string,
    @Query('format') format: string | undefined,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
    @Res({ passthrough: true }) reponse: Response,
  ): Promise<StreamableFile> {
    const certificat = await this.certificats.construire(user.tenantId, id);
    const recalculee = this.certificats.empreinte(certificat);
    const figee = await this.certificats.empreinteFigee(user.tenantId, id);

    // L'empreinte qui fait foi est celle scellée à la destruction. Si la
    // reconstruction ne la reproduit plus — une évolution du produit a changé
    // ce que le certificat énonce — on ne substitue pas l'une à l'autre en
    // silence : on sert la pièce et on dit que sa reconstruction a divergé.
    // C'est le principe du §9.8 : le produit ne refuse pas de livrer, il
    // refuse de mentir.
    const empreinte = figee ?? recalculee;
    const reproduit = figee === null || figee === recalculee;
    const csv = format === 'csv';

    const contenu = csv
      ? Buffer.from(construireCertificatCsv(certificat, empreinte), 'utf8')
      : await construireCertificatPdf(certificat, empreinte);

    // Un certificat qui sort du produit devient une pièce autonome : il se
    // trace, comme l'extrait du journal au §9.11.
    await this.audit.record({
      tenantId: user.tenantId,
      userId: user.userId,
      action: 'EXPORT',
      ip: request.ip ?? null,
      detail: {
        objet: 'certificat-purge',
        rapportId: id,
        format: csv ? 'csv' : 'pdf',
        sha256Certificat: empreinte,
        detruits: certificat.totaux.detruits,
        ...(reproduit ? {} : { reproduction: 'divergente', sha256Recalcule: recalculee }),
      },
    });

    reponse.set({
      'Content-Type': csv ? 'text/csv; charset=utf-8' : 'application/pdf',
      'Content-Disposition': `attachment; filename="certificat-destruction-${id}.${csv ? 'csv' : 'pdf'}"`,
      'Cache-Control': 'private, no-store',
      'X-Certificat-Sha256': empreinte,
      'X-Certificat-Reproduit': reproduit ? 'oui' : 'non',
    });
    return new StreamableFile(contenu);
  }

  /** Établir un rapport ne détruit rien : ADMIN et SUPERVISOR peuvent le demander. */
  @Roles('ADMIN', 'SUPERVISOR')
  @Post()
  simuler(@CurrentUser() user: AuthUser, @Req() request: Request): Promise<PurgeReportSummary> {
    return this.purge.simuler(user, request.ip ?? null);
  }

  /** Lecture ouverte à l'AUDITOR : c'est la pièce qu'il vient vérifier. */
  @Roles('ADMIN', 'SUPERVISOR', 'AUDITOR')
  @Get()
  lister(
    @Query() query: ListReportsDto,
    @CurrentUser() user: AuthUser,
  ): Promise<Page<PurgeReportSummary>> {
    return this.purge.lister(user.tenantId, query);
  }

  @Roles('ADMIN', 'SUPERVISOR', 'AUDITOR')
  @Get(':id')
  lire(
    @Param('id') id: string,
    @Query() query: ReadReportDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PurgeReportDetail> {
    return this.purge.lire(user.tenantId, id, query);
  }

  /** Détruire est réservé à l'ADMIN, et ne se fait que sur un rapport lu. */
  @Roles('ADMIN')
  @Post(':id/execute')
  @HttpCode(HttpStatus.OK)
  executer(
    @Param('id') id: string,
    @Body() dto: ExecutePurgeDto,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<PurgeReportSummary> {
    return this.purge.executer(user, id, dto, request.ip ?? null);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  annuler(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<PurgeReportSummary> {
    return this.purge.annuler(user, id, request.ip ?? null);
  }
}
