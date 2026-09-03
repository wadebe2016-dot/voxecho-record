import { Module } from '@nestjs/common';
import { HealthController, InstanceController } from './health.controller';

@Module({ controllers: [HealthController, InstanceController] })
export class HealthModule {}
