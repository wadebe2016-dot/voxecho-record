import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { AuthService } from './auth.service';
import type { AuthUser, TokenPair } from './auth.types';
import { LimitationConnexionGuard } from './limitation-connexion.guard';
import { ChangePasswordDto } from './dto/change-password.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshDto } from './dto/refresh.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @UseGuards(LimitationConnexionGuard)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body() dto: LoginDto, @Req() request: Request): Promise<TokenPair> {
    return this.auth.login(dto.email, dto.password, adresse(request));
  }

  // Le rafraîchissement est protégé par le même verdict d'adresse, mais ses
  // échecs ne comptent pas : un jeton expiré est le quotidien d'une session,
  // pas le signe d'un balayage.
  @Public()
  @UseGuards(LimitationConnexionGuard)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body() dto: RefreshDto): Promise<TokenPair> {
    return this.auth.refresh(dto.refreshToken);
  }

  @Post('password')
  @HttpCode(HttpStatus.OK)
  changerMotDePasse(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<TokenPair> {
    return this.auth.changerMotDePasse(user, dto.ancien, dto.nouveau, adresse(request));
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Body() dto: Partial<RefreshDto>, @CurrentUser() user: AuthUser): Promise<void> {
    return this.auth.logout(dto.refreshToken, user);
  }

  @Get('me')
  profil(@CurrentUser() user: AuthUser) {
    return this.auth.profil(user);
  }
}

/** Adresse d'origine, telle qu'elle sera consignée au journal d'audit. */
function adresse(request: Request): string | null {
  return request.ip ?? request.socket.remoteAddress ?? null;
}
