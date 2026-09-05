import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AppConfig } from '../config/config.module';
import { AnnuaireService } from './annuaire.service';

/** On regarde s'il y a lieu de synchroniser à cette cadence, pas plus. */
const PAS_MS = 5 * 60 * 1000;

/**
 * Synchronisation périodique de l'annuaire — CLAUDE.md §9.37.
 *
 * Une minuterie plutôt qu'un ordonnanceur : le produit n'a qu'une tâche
 * périodique, et l'ajout d'une dépendance pour la porter coûterait plus qu'il
 * ne rapporte. Le pas est fixe et l'échéance se calcule à chaque réveil — une
 * minuterie réglée sur l'intervalle serait à refaire à chaque changement du
 * réglage.
 *
 * Elle ne tourne pas en test : un balayage qui désactive des comptes n'a rien
 * à faire dans une suite qui en crée.
 */
@Injectable()
export class AnnuaireSynchroService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AnnuaireSynchroService.name);
  private minuterie: NodeJS.Timeout | null = null;
  private dernierPassage = 0;

  constructor(
    private readonly annuaire: AnnuaireService,
    private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (this.config.get('NODE_ENV') === 'test') return;
    this.minuterie = setInterval(() => void this.peutEtre(), PAS_MS);
    // `unref` : une minuterie ne doit pas retenir le processus à l'arrêt.
    this.minuterie.unref();
  }

  onModuleDestroy(): void {
    if (this.minuterie !== null) clearInterval(this.minuterie);
  }

  private async peutEtre(): Promise<void> {
    try {
      const { reglages } = await this.annuaire.lire();
      if (!reglages.actif || !reglages.synchro.actif) return;

      const intervalleMs = reglages.synchro.intervalleHeures * 3600 * 1000;
      if (Date.now() - this.dernierPassage < intervalleMs) return;

      this.dernierPassage = Date.now();
      await this.annuaire.synchroniser();
    } catch (e) {
      // Un annuaire injoignable ne doit rien fermer : on le dit et on
      // réessaiera au réveil suivant.
      this.logger.warn(
        `Synchronisation annuaire ajournée : ${e instanceof Error ? e.message : 'cause inconnue'}`,
      );
    }
  }
}
