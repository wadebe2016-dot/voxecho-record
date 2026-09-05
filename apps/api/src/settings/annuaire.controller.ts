import { Body, Controller, Get, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { ReglagesAnnuaireResponse, ResultatTestAnnuaire } from '@voxecho/shared';
import { AdminInstance } from '../common/decorators/admin-instance.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { AnnuaireService } from './annuaire.service';
import { MajAnnuaireDto, TestAnnuaireDto } from './dto/maj-annuaire.dto';

/**
 * Onglet Annuaire — CLAUDE.md §9.37.
 *
 * Réservé à l'administrateur de l'instance : ce réglage décide qui entre dans
 * le produit et avec quel rôle, donc qui peut entendre des conversations de
 * clients. Le mot de passe de liaison n'en sort jamais.
 */
@Controller('administration/annuaire')
export class AnnuaireController {
  constructor(private readonly annuaire: AnnuaireService) {}

  @AdminInstance()
  @Get()
  lire(): Promise<ReglagesAnnuaireResponse> {
    return this.annuaire.lire();
  }

  @AdminInstance()
  @Put()
  definir(
    @Body() dto: MajAnnuaireDto,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<ReglagesAnnuaireResponse> {
    return this.annuaire.definir(dto, user, request.ip ?? null);
  }

  @AdminInstance()
  @Post('test')
  tester(
    @Body() dto: TestAnnuaireDto,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<ResultatTestAnnuaire> {
    return this.annuaire.tester(dto.login, user, request.ip ?? null);
  }

  /** Déclenche une synchronisation sans attendre l'échéance. */
  @AdminInstance()
  @Post('synchroniser')
  synchroniser(): Promise<{ vus: number; desactives: number }> {
    return this.annuaire.synchroniser();
  }
}
