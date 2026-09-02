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
} from '@nestjs/common';
import type { Request } from 'express';
import type { Page, PurgeReportDetail, PurgeReportSummary } from '@voxecho/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthUser } from '../auth/auth.types';
import { ExecutePurgeDto } from './dto/execute-purge.dto';
import { ListReportsDto } from './dto/list-reports.dto';
import { ReadReportDto } from './dto/read-report.dto';
import { PurgeService } from './purge.service';

/**
 * Purge — CLAUDE.md §5 et §9.7.
 *
 * Aucune purge automatique : le produit énumère, un responsable conformité
 * valide, un ADMIN exécute. Le rapport est l'autorisation.
 */
@Controller('purge/reports')
export class PurgeController {
  constructor(private readonly purge: PurgeService) {}

  /** Établir un rapport ne détruit rien : ADMIN et SUPERVISOR peuvent le demander. */
  @Roles('ADMIN', 'SUPERVISOR')
  @Post()
  simuler(@CurrentUser() user: AuthUser): Promise<PurgeReportSummary> {
    return this.purge.simuler(user);
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
  annuler(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<PurgeReportSummary> {
    return this.purge.annuler(user, id);
  }
}
