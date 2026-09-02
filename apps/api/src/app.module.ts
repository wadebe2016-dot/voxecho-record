import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { TenantGuard } from './common/guards/tenant.guard';
import { AppConfigModule } from './config/config.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { ExportModule } from './export/export.module';
import { HealthModule } from './health/health.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './storage/storage.module';
import { PurgeModule } from './purge/purge.module';
import { RecordingsModule } from './recordings/recordings.module';
import { RetentionModule } from './retention/retention.module';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    StorageModule,
    AuditModule,
    AuthModule,
    IngestionModule,
    RecordingsModule,
    RetentionModule,
    PurgeModule,
    ExportModule,
    DashboardModule,
    HealthModule,
  ],
  providers: [
    // Ordre volontaire : authentifier, puis cloisonner, puis autoriser.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: TenantGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
