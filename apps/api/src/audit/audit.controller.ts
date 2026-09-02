import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AUDIT_CSV_FILENAME, type AuditEventItem, type Page } from '@voxecho/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthUser } from '../auth/auth.types';
import { AuditReadService } from './audit-read.service';
import { ListAuditDto } from './dto/list-audit.dto';

/**
 * Journal d'audit — CLAUDE.md §6 : « consultable par ADMIN/AUDITOR,
 * filtrable, export CSV ».
 *
 * Le SUPERVISOR en est écarté pour la même raison qu'il n'écoute pas (§9.9) :
 * le journal dit qui a entendu quoi, et le donner à lire à qui n'a pas
 * l'habilitation d'écoute reviendrait à lui livrer indirectement l'activité
 * des auditeurs.
 *
 * Aucune route d'écriture, ni ici ni ailleurs : le journal est append-only.
 */
@Controller('audit')
export class AuditController {
  constructor(private readonly journal: AuditReadService) {}

  @Roles('ADMIN', 'AUDITOR')
  @Get()
  list(@Query() query: ListAuditDto, @CurrentUser() user: AuthUser): Promise<Page<AuditEventItem>> {
    return this.journal.list(user, query);
  }

  /**
   * Export CSV du journal filtré. C'est une pièce qui sort du produit : elle
   * est elle-même inscrite au journal (§9.11).
   */
  @Roles('ADMIN', 'AUDITOR')
  @Get('export.csv')
  async exporterCsv(
    @Query() query: ListAuditDto,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const { csv, lignes, tronque } = await this.journal.exporterCsv(
      user,
      query,
      request.ip ?? null,
    );

    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="${AUDIT_CSV_FILENAME}"`);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Audit-Lignes', String(lignes));
    // Un extrait tronqué doit se savoir : un contrôleur qui croit tenir le
    // journal entier tirerait des conclusions fausses d'un silence.
    response.setHeader('X-Audit-Tronque', tronque ? 'true' : 'false');
    response.status(200).end(csv);
  }
}
