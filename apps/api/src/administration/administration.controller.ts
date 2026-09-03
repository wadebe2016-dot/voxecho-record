import { Controller, Get } from '@nestjs/common';
import type { InstanceSettingsResponse } from '@voxecho/shared';
import { AdminInstance } from '../common/decorators/admin-instance.decorator';
import { AdministrationService } from './administration.service';

/**
 * Console d'administration — CLAUDE.md §9.22.
 *
 * Réservée à l'administrateur de l'instance, et non à l'ADMIN d'un locataire :
 * ce qu'on lit ici vaut pour toutes les banques hébergées.
 *
 * La consultation ne s'inscrit pas au journal, comme la lecture du journal
 * lui-même (§9.11) : tracer chaque ouverture d'un écran de réglages noierait
 * les actes sous les regards. Ce sont les changements qui se tracent — et ce
 * lot n'en permet aucun.
 */
@Controller('administration')
export class AdministrationController {
  constructor(private readonly administration: AdministrationService) {}

  @AdminInstance()
  @Get('reglages')
  reglages(): Promise<InstanceSettingsResponse> {
    return this.administration.reglages();
  }
}
