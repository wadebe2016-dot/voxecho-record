import { Module } from '@nestjs/common';
import { RetentionModule } from '../retention/retention.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [RetentionModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
