import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { IngestionScheduler } from './ingestion.scheduler';
import { IngestionService } from './ingestion.service';

@Module({
  imports: [AuditModule],
  providers: [IngestionService, IngestionScheduler],
  exports: [IngestionService],
})
export class IngestionModule {}
