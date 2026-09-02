import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * Global : la réécoute, l'export et l'ingestion passent tous par le même
 * accès au stockage, et aucun d'eux n'a à savoir si la pièce est scellée.
 */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
