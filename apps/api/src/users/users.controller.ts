import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { TemporaryPasswordResponse, UserSummary } from '@voxecho/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CreateUserDto } from './dto/create-user.dto';
import { RattacherDto } from './dto/rattacher.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UsersService } from './users.service';

/**
 * Comptes d'un locataire — CLAUDE.md §9.26.
 *
 * Réservé à l'ADMIN du locataire. Il n'y a pas de suppression : un compte se
 * désactive, parce que le journal d'audit référence son auteur et qu'effacer
 * un compte effacerait le lien vers ce qu'il a écouté.
 */
@Controller('users')
@Roles('ADMIN')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  lister(@CurrentUser() user: AuthUser): Promise<UserSummary[]> {
    return this.users.lister(user.tenantId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  creer(
    @Body() dto: CreateUserDto,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<TemporaryPasswordResponse> {
    return this.users.creer(user, dto, request.ip ?? null);
  }

  @Patch(':id')
  modifier(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<UserSummary> {
    return this.users.modifier(user, id, dto, request.ip ?? null);
  }

  @Post(':id/reinitialiser')
  @HttpCode(HttpStatus.OK)
  reinitialiser(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<TemporaryPasswordResponse> {
    return this.users.reinitialiser(user, id, request.ip ?? null);
  }

  /**
   * Rattache un compte local à l'annuaire — CLAUDE.md §9.37. C'est le seul
   * chemin par lequel un compte change d'autorité, et il retire son mot de
   * passe local à son titulaire.
   */
  @Post(':id/rattacher-annuaire')
  @HttpCode(HttpStatus.OK)
  rattacher(
    @Param('id') id: string,
    @Body() dto: RattacherDto,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<UserSummary> {
    return this.users.rattacherALAnnuaire(
      user,
      id,
      request.ip ?? null,
      dto.acceptSansContreValidation === true,
    );
  }
}

