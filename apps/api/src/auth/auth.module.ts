import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SettingsModule } from '../settings/settings.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokensService } from './tokens.service';
import { LimitationConnexion } from './limitation-connexion.service';
import { LimitationConnexionGuard } from './limitation-connexion.guard';

@Module({
  imports: [JwtModule.register({}), SettingsModule],
  controllers: [AuthController],
  providers: [AuthService, TokensService, LimitationConnexion, LimitationConnexionGuard],
  exports: [TokensService],
})
export class AuthModule {}
