import { Module } from '@nestjs/common';
import { PolicyController } from './policy.controller';
import { PolicyService } from './policy.service';

@Module({
  controllers: [PolicyController],
  providers: [PolicyService],
  // Le connecteur ira lire la politique en vigueur au lot suivant (§9.23) :
  // le service est exporté pour que la publication puisse s'y brancher.
  exports: [PolicyService],
})
export class PolicyModule {}
