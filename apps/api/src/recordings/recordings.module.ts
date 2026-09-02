import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { RetentionModule } from '../retention/retention.module';
import { ListenTicketService } from './listen-ticket.service';
import { RecordingsController } from './recordings.controller';
import { RecordingsService } from './recordings.service';

@Module({
  // La liste marque les appels sous conservation forcée : le hold se lit
  // dans `LegalHold`, jamais dans une copie portée par l'enregistrement.
  imports: [JwtModule.register({}), RetentionModule],
  controllers: [RecordingsController],
  providers: [RecordingsService, ListenTicketService],
})
export class RecordingsModule {}
