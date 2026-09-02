import { Controller, Get, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { Page, RecordingListItem } from '@voxecho/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import type { AuthUser } from '../auth/auth.types';
import { ListRecordingsDto } from './dto/list-recordings.dto';
import { RecordingsService } from './recordings.service';

@Controller('recordings')
export class RecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

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
}
