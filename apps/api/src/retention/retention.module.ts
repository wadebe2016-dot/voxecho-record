import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { LegalHoldsController, RetentionController } from './retention.controller';
import { LegalHoldsService } from './legal-holds.service';
import { RetentionService } from './retention.service';

@Module({
  imports: [AuditModule],
  controllers: [RetentionController, LegalHoldsController],
  providers: [RetentionService, LegalHoldsService],
  // La liste des enregistrements marque les appels sous conservation forcée,
  // et la purge (lot 02) s'appuiera sur les mêmes services.
  exports: [RetentionService, LegalHoldsService],
})
export class RetentionModule {}
