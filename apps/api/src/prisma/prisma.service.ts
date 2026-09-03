import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    await this.exigerSessionUtc();
    this.logger.log('Connexion à PostgreSQL établie');
  }

  /**
   * Refuse de démarrer si la session n'est pas en UTC — CLAUDE.md §9.27.
   *
   * Les colonnes à `DEFAULT CURRENT_TIMESTAMP` prennent l'heure du fuseau de
   * session, et sont relues comme de l'UTC : un serveur réglé sur Africa/Douala
   * décale d'une heure chaque entrée du journal d'audit, sans que rien ne le
   * signale. L'url de connexion impose le fuseau ; ce contrôle vérifie qu'il a
   * bien pris, y compris quand l'exploitant fournit ses propres options.
   *
   * Comme la validation d'environnement (§2) : mieux vaut ne pas démarrer
   * qu'écrire des horodatages faux dans un journal qu'on ne peut pas corriger.
   */
  private async exigerSessionUtc(): Promise<void> {
    const [ligne] = await this.$queryRawUnsafe<{ fuseau: string }[]>(
      "SELECT current_setting('TimeZone') AS fuseau",
    );
    const fuseau = ligne?.fuseau ?? 'inconnu';
    if (fuseau !== 'UTC') {
      throw new Error(
        `Session PostgreSQL en « ${fuseau} » : les horodatages écrits par la base seraient décalés ` +
          'et le journal d’audit deviendrait faux. Retirer le réglage de fuseau de la base, ou ' +
          'ajouter `options=-c timezone=UTC` à DATABASE_URL (CLAUDE.md §9.27).',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
