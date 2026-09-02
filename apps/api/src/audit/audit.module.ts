import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditReadService } from './audit-read.service';
import { AuditService } from './audit.service';

@Global()
@Module({
  controllers: [AuditController],
  // `AuditService` écrit, `AuditReadService` lit. Les deux restent séparés
  // pour qu'une lecture ne puisse pas devenir une écriture par accident : le
  // journal est append-only.
  providers: [AuditService, AuditReadService],
  exports: [AuditService],
})
export class AuditModule {}
