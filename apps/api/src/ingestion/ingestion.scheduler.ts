import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AppConfig } from '../config/config.module';
import { IngestionService } from './ingestion.service';

/**
 * Déclenche le balayage d'INGEST_DIR à intervalle régulier.
 *
 * Le balayage est préféré à `fs.watch` : le répertoire d'ingestion est
 * presque toujours un volume monté ou un partage réseau, où les événements du
 * système de fichiers se perdent ou n'existent pas. Un balayage rattrape en
 * outre tout ce qui a été déposé pendant un arrêt de l'api — un
 * enregistrement de conformité ne doit pas dépendre du fait que le portail
 * était allumé au bon moment.
 */
@Injectable()
export class IngestionScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestionScheduler.name);
  private minuterie?: NodeJS.Timeout;

  constructor(
    private readonly ingestion: IngestionService,
    private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.get('INGEST_POLL_ENABLED')) {
      this.logger.log('Balayage périodique désactivé (INGEST_POLL_ENABLED=false)');
      return;
    }
    const periode = this.config.get('INGEST_POLL_MS');
    this.minuterie = setInterval(() => void this.balayer(), periode);
    // Ne retient pas le processus à l'arrêt.
    this.minuterie.unref();
    this.logger.log(`Balayage d'INGEST_DIR toutes les ${periode} ms`);
  }

  onModuleDestroy(): void {
    if (this.minuterie) clearInterval(this.minuterie);
  }

  private async balayer(): Promise<void> {
    const report = await this.ingestion.scan();
    if (report.ingested > 0 || report.quarantined > 0 || report.duplicates > 0) {
      this.logger.log(
        `Ingestion : ${report.ingested} enregistrés, ${report.duplicates} doublons, ${report.quarantined} en quarantaine`,
      );
    }
  }
}
