import { Body, Controller, Get, Post, Param, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import type {
  LegalHoldResponse,
  RetentionPolicyResponse,
  RetentionPolicySetResponse,
} from '@voxecho/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthUser } from '../auth/auth.types';
import { HoldReasonDto } from './dto/hold-reason.dto';
import { LegalHoldsService } from './legal-holds.service';
import { RetentionService } from './retention.service';
import { SetRetentionDto } from './dto/set-retention.dto';

/**
 * Politique de conservation d'un locataire — CLAUDE.md §5.
 *
 * Lecture ouverte aux trois rôles : un auditeur doit pouvoir répondre à
 * « combien de temps gardez-vous les appels ? » sans demander à l'exploitant.
 * L'écriture est réservée à l'ADMIN — c'est le seul acte du produit qui
 * programme la destruction de preuves.
 */
@Controller('retention')
export class RetentionController {
  constructor(private readonly retention: RetentionService) {}

  @Roles('ADMIN', 'SUPERVISOR', 'AUDITOR')
  @Get()
  lire(@CurrentUser() user: AuthUser): Promise<RetentionPolicyResponse> {
    return this.retention.lire(user.tenantId);
  }

  /** Toutes les politiques : la générale et celles par catégorie (§9.28). */
  @Roles('ADMIN', 'SUPERVISOR', 'AUDITOR')
  @Get('ensemble')
  lireEnsemble(@CurrentUser() user: AuthUser): Promise<RetentionPolicySetResponse> {
    return this.retention.lireEnsemble(user.tenantId);
  }

  @Roles('ADMIN')
  @Put()
  definir(
    @Body() dto: SetRetentionDto,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<RetentionPolicyResponse> {
    return this.retention.definir(user, dto, request.ip ?? null);
  }
}

/**
 * Conservation forcée — CLAUDE.md §5.
 *
 * Poser et lever sont ouverts à l'ADMIN et au SUPERVISOR : c'est un acte de
 * conformité, pas d'exploitation. L'AUDITOR consulte l'historique sans
 * pouvoir y toucher — il constate, il n'ordonne pas.
 */
@Controller('recordings')
export class LegalHoldsController {
  constructor(private readonly holds: LegalHoldsService) {}

  @Roles('ADMIN', 'SUPERVISOR', 'AUDITOR')
  @Get(':id/holds')
  historique(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<LegalHoldResponse[]> {
    return this.holds.historique(user.tenantId, id);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Post(':id/holds')
  poser(
    @Param('id') id: string,
    @Body() dto: HoldReasonDto,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<LegalHoldResponse> {
    return this.holds.poser(user, id, dto, request.ip ?? null);
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Post(':id/holds/release')
  lever(
    @Param('id') id: string,
    @Body() dto: HoldReasonDto,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<LegalHoldResponse> {
    return this.holds.lever(user, id, dto, request.ip ?? null);
  }
}
