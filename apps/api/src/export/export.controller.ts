import { Controller, HttpCode, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthUser } from '../auth/auth.types';
import { ExportService } from './export.service';

/**
 * Export horodaté — CLAUDE.md §6 et §9.8.
 *
 * `POST` et non `GET` : un export a un effet, il s'inscrit au journal
 * d'audit. Le portail l'appelle avec son jeton habituel et reçoit l'archive
 * en réponse — pas de billet dans l'url ici, contrairement à l'écoute : c'est
 * le portail qui demande le fichier, pas un `<audio>` incapable de porter un
 * en-tête (§9.4).
 */
@Controller('recordings')
export class ExportController {
  constructor(private readonly exports: ExportService) {}

  /**
   * Même habilitation que l'écoute (§9.9) : une archive contient l'audio, donc
   * l'exporter revient à pouvoir l'entendre. Ouvrir l'export à qui n'a pas
   * l'écoute rendrait la restriction décorative.
   */
  @Roles('ADMIN', 'AUDITOR')
  @Post(':id/export')
  @HttpCode(HttpStatus.OK)
  async exporter(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const archive = await this.exports.exporter(user, id, request.ip ?? null);

    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Disposition', `attachment; filename="${archive.nomArchive}"`);
    response.setHeader('Content-Length', String(archive.contenu.byteLength));
    // Une pièce probante ne se met pas en cache chez un intermédiaire.
    response.setHeader('Cache-Control', 'private, no-store');
    // De quoi retrouver l'export au journal sans ouvrir l'archive, et de quoi
    // avertir l'auditeur si l'empreinte a divergé.
    response.setHeader('X-Export-Id', archive.exportId);
    response.setHeader('X-Export-Integrite', archive.integrite);
    response.status(HttpStatus.OK).end(archive.contenu);
  }
}
