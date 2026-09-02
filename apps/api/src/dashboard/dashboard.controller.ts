import { Controller, Get } from '@nestjs/common';
import type { DashboardResponse } from '@voxecho/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthUser } from '../auth/auth.types';
import { DashboardService } from './dashboard.service';

/**
 * Tableau de bord — CLAUDE.md §6.
 *
 * Ouvert aux trois rôles, y compris au SUPERVISOR : ce sont des chiffres
 * d'exploitation. Rien n'y dit qui a écouté quoi — les quarantaines n'ont pas
 * d'auteur humain, et le reste est du volume. C'est ce qui le distingue du
 * journal d'audit, dont le SUPERVISOR reste écarté (§9.9, §9.11).
 */
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Roles('ADMIN', 'SUPERVISOR', 'AUDITOR')
  @Get()
  lire(@CurrentUser() user: AuthUser): Promise<DashboardResponse> {
    return this.dashboard.lire(user.tenantId);
  }
}
