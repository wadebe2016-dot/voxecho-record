import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RetentionModule } from '../retention/retention.module';
import { CertificatService } from './certificat.service';
import { PurgeController } from './purge.controller';
import { PurgeService } from './purge.service';

@Module({
  imports: [AuditModule, RetentionModule],
  controllers: [PurgeController],
  providers: [PurgeService, CertificatService],
})
export class PurgeModule {}
