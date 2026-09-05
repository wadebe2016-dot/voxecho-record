import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AnnuaireController } from './annuaire.controller';
import { AnnuaireService } from './annuaire.service';
import { AnnuaireSynchroService } from './annuaire-synchro.service';
import { InstanceSettingsService } from './instance-settings.service';
import { ReseauController } from './reseau.controller';
import { ReseauService } from './reseau.service';

/**
 * Réglages d'instance — CLAUDE.md §9.36. Le socle (table clé/valeur,
 * versionnement, journal, cache) et les onglets qui s'y branchent.
 */
@Module({
  imports: [AuditModule],
  controllers: [ReseauController, AnnuaireController],
  providers: [InstanceSettingsService, ReseauService, AnnuaireService, AnnuaireSynchroService],
  exports: [InstanceSettingsService, ReseauService, AnnuaireService],
})
export class SettingsModule {}
