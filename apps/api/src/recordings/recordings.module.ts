import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ListenTicketService } from './listen-ticket.service';
import { RecordingsController } from './recordings.controller';
import { RecordingsService } from './recordings.service';

@Module({
  imports: [JwtModule.register({})],
  controllers: [RecordingsController],
  providers: [RecordingsService, ListenTicketService],
})
export class RecordingsModule {}
