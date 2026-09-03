import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { PolicyVersionDetail, PolicyVersionSummary } from '@voxecho/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthUser } from '../auth/auth.types';
import { PublishPolicyDto } from './dto/publish.dto';
import { SavePolicyDraftDto } from './dto/save-draft.dto';
import { PolicyService } from './policy.service';

/**
 * Politiques d'enregistrement — CLAUDE.md §9.23.
 *
 * Lecture ouverte aux trois rôles : « quelle politique s'appliquait ce
 * jour-là ? » est une question de conformité, et un auditeur doit pouvoir y
 * répondre sans demander à l'exploitant. L'écriture est réservée à l'ADMIN du
 * locataire — c'est lui qui engage la banque en renonçant à des preuves.
 */
@Controller('policies')
export class PolicyController {
  constructor(private readonly policies: PolicyService) {}

  @Roles('ADMIN', 'SUPERVISOR', 'AUDITOR')
  @Get()
  lister(@CurrentUser() user: AuthUser): Promise<PolicyVersionSummary[]> {
    return this.policies.lister(user.tenantId);
  }

  @Roles('ADMIN', 'SUPERVISOR', 'AUDITOR')
  @Get('en-vigueur')
  enVigueur(@CurrentUser() user: AuthUser): Promise<PolicyVersionDetail | null> {
    return this.policies.enVigueur(user.tenantId);
  }

  @Roles('ADMIN')
  @Get('brouillon')
  brouillon(@CurrentUser() user: AuthUser): Promise<PolicyVersionDetail | null> {
    return this.policies.brouillon(user.tenantId);
  }

  @Roles('ADMIN')
  @Put('brouillon')
  enregistrer(
    @Body() dto: SavePolicyDraftDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PolicyVersionDetail> {
    return this.policies.enregistrerBrouillon(user, dto.document);
  }

  @Roles('ADMIN')
  @Delete('brouillon')
  @HttpCode(HttpStatus.NO_CONTENT)
  abandonner(@CurrentUser() user: AuthUser): Promise<void> {
    return this.policies.abandonnerBrouillon(user.tenantId);
  }

  @Roles('ADMIN')
  @Post('brouillon/publier')
  @HttpCode(HttpStatus.OK)
  publier(
    @Body() dto: PublishPolicyDto,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<PolicyVersionDetail> {
    return this.policies.publier(user, dto, request.ip ?? null);
  }
}
