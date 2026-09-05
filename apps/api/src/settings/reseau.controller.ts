import { Body, Controller, Get, Post, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import type {
  EtatHorloge,
  ReglagesReseauResponse,
  ResultatTestDns,
  ResultatTestNtp,
} from '@voxecho/shared';
import { AdminInstance } from '../common/decorators/admin-instance.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { MajReseauDto } from './dto/maj-reseau.dto';
import { ReseauService } from './reseau.service';

/**
 * Onglet Réseau des réglages d'instance — CLAUDE.md §9.36.
 *
 * Réservé à l'administrateur de l'instance : ce qu'on règle ici vaut pour
 * toutes les banques hébergées, et le fuseau d'affichage comme les relais de
 * confiance décident de ce que le journal d'audit dira.
 *
 * La consultation ne s'inscrit pas au journal (§9.11) ; les changements et les
 * tests, si.
 */
@Controller('administration/reseau')
export class ReseauController {
  constructor(private readonly reseau: ReseauService) {}

  /**
   * État de l'horloge, ouvert aux trois rôles.
   *
   * Le bandeau qui prévient d'un horodatage non fiable s'affiche en tête de
   * **toute** la console : un auditeur qui relève une empreinte doit savoir que
   * l'heure inscrite à côté n'est peut-être pas défendable. Le réserver à
   * l'administrateur de l'instance aurait laissé les autres travailler sur des
   * dates qu'on sait fausses.
   */
  @Roles('ADMIN', 'SUPERVISOR', 'AUDITOR')
  @Get('horloge')
  horloge(): Promise<EtatHorloge> {
    return this.reseau.horloge();
  }

  @AdminInstance()
  @Get()
  lire(): Promise<ReglagesReseauResponse> {
    return this.reseau.lire();
  }

  @AdminInstance()
  @Put()
  definir(
    @Body() dto: MajReseauDto,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<ReglagesReseauResponse> {
    return this.reseau.definir(dto, user, request.ip ?? null);
  }

  @AdminInstance()
  @Post('test/ntp')
  testerNtp(
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<ResultatTestNtp[]> {
    return this.reseau.testerNtp(user, request.ip ?? null);
  }

  @AdminInstance()
  @Post('test/dns')
  testerDns(
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<ResultatTestDns[]> {
    return this.reseau.testerDns(user, request.ip ?? null);
  }
}
