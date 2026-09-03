import { Controller, Get } from '@nestjs/common';
import type { InstanceInfoResponse } from '@voxecho/shared';
import { Public } from '../common/decorators/public.decorator';
import { AppConfig } from '../config/config.module';

/**
 * Sonde de vie, sans authentification et sans information sensible :
 * elle sert au docker-compose et au futur équilibrage de charge.
 */
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  check(): { status: 'ok'; service: string; time: string } {
    return {
      status: 'ok',
      service: 'voxecho-record-api',
      time: new Date().toISOString(),
    };
  }
}

/**
 * Ce que le portail apprend avant toute connexion — CLAUDE.md §9.18.
 *
 * Publique par nécessité : l'écran de connexion l'interroge, et c'est
 * précisément là que la mention « version d'évaluation » doit apparaître. Elle
 * révèle rien qu'un visiteur ne puisse constater par lui-même.
 */
@Controller('instance')
export class InstanceController {
  constructor(private readonly config: AppConfig) {}

  @Public()
  @Get()
  info(): InstanceInfoResponse {
    return { evaluation: this.config.get('INSTANCE_EVALUATION') };
  }
}
