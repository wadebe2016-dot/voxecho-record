import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RetentionModule } from '../retention/retention.module';
import { PurgeController } from './purge.controller';
import { PurgeService } from './purge.service';

@Module({
  imports: [AuditModule, RetentionModule],
  controllers: [PurgeController],
  providers: [PurgeService],
})
export class PurgeModule {}
