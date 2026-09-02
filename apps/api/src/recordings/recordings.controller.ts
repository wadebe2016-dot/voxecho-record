import { createReadStream } from 'node:fs';
import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ListenTicketResponse, Page, RecordingListItem } from '@voxecho/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthUser } from '../auth/auth.types';
import { ListRecordingsDto } from './dto/list-recordings.dto';
import { ListenAudioDto } from './dto/listen-audio.dto';
import { ListenTicketService } from './listen-ticket.service';
import { analyserRange } from './range';
import { RecordingsService } from './recordings.service';

/** Le contrat §3 ne dépose que du WAV PCM. */
const TYPE_AUDIO = 'audio/wav';

@Controller('recordings')
export class RecordingsController {
  constructor(
    private readonly recordings: RecordingsService,
    private readonly billets: ListenTicketService,
  ) {}

  /** Consultable par les trois rôles ; le cloisonnement vient du jeton. */
  @Roles('ADMIN', 'SUPERVISOR', 'AUDITOR')
  @Get()
  list(
    @Query() query: ListRecordingsDto,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<Page<RecordingListItem>> {
    return this.recordings.list(user, query, request.ip ?? null);
  }

  /**
   * Ouvre une écoute et rend le billet qui la porte. C'est cet appel — un par
   * écoute — qui inscrit l'`AuditEvent LISTEN`.
   *
   * Habilitation restreinte (CLAUDE.md §9.9) : entendre une conversation de
   * client n'est pas un droit d'exploitation. Le SUPERVISOR voit les appels et
   * leurs métadonnées, il ne les écoute pas.
   */
  @Roles('ADMIN', 'AUDITOR')
  @Post(':id/listen')
  @HttpCode(HttpStatus.OK)
  ouvrirEcoute(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
  ): Promise<ListenTicketResponse> {
    return this.recordings.ouvrirEcoute(user, id, request.ip ?? null);
  }

  /**
   * Sert l'audio, en entier ou par plages. Rien n'est tracé ici : le lecteur
   * émet une requête par saut et par remplissage de tampon, et les consigner
   * noierait le journal sous des événements que personne n'a provoqués.
   */
  @Public()
  @Get(':id/audio')
  async audio(
    @Param('id') id: string,
    @Query() query: ListenAudioDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const billet = await this.billets.verify(query.ticket, id);
    const flux = await this.recordings.ouvrirFlux(billet);
    const demande = analyserRange(request.headers.range, flux.taille);

    response.setHeader('Content-Type', TYPE_AUDIO);
    response.setHeader('Accept-Ranges', 'bytes');
    // Une pièce probante ne se met pas en cache chez un intermédiaire.
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Content-Disposition', `inline; filename="${flux.nomFichier}"`);

    if (demande.type === 'insatisfiable') {
      response.setHeader('Content-Range', `bytes */${flux.taille}`);
      response.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE).end();
      return;
    }

    const { debut, fin } =
      demande.type === 'partiel' ? demande.plage : { debut: 0, fin: Math.max(0, flux.taille - 1) };
    const longueur = flux.taille === 0 ? 0 : fin - debut + 1;

    if (demande.type === 'partiel') {
      response.setHeader('Content-Range', `bytes ${debut}-${fin}/${flux.taille}`);
      response.status(HttpStatus.PARTIAL_CONTENT);
    } else {
      response.status(HttpStatus.OK);
    }
    response.setHeader('Content-Length', String(longueur));

    if (request.method === 'HEAD' || longueur === 0) {
      response.end();
      return;
    }

    const lecture = createReadStream(flux.chemin, { start: debut, end: fin });
    // L'auditeur qui ferme l'onglet coupe la connexion en pleine lecture :
    // c'est banal, cela ne doit ni fuir un descripteur ni polluer les
    // journaux.
    lecture.on('error', () => response.destroy());
    response.on('close', () => lecture.destroy());
    lecture.pipe(response);
  }
}
