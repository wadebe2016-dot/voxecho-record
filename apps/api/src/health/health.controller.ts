import { Controller, Get } from '@nestjs/common';

/**
 * Sonde de vie, sans authentification et sans information sensible :
 * elle sert au docker-compose et au futur équilibrage de charge.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok'; service: string; time: string } {
    return {
      status: 'ok',
      service: 'voxecho-record-api',
      time: new Date().toISOString(),
    };
  }
}
