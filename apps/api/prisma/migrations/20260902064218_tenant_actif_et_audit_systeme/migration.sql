-- Un locataire se désactive au lieu de s'effacer : ses dépôts d'ingestion
-- partent alors en quarantaine (contrat §3).
ALTER TABLE "tenants" ADD COLUMN "active" BOOLEAN NOT NULL DEFAULT true;

-- Un dépôt trouvé dans un sous-répertoire ne correspondant à aucun locataire
-- actif doit laisser une trace, mais il n'y a précisément aucun locataire à
-- qui l'attribuer : `tenant_id` devient nul pour ces seuls événements
-- système. Le journal reste append-only et cloisonné — un locataire ne voit
-- que ses propres événements, un événement système n'appartient à personne.
ALTER TABLE "audit_events" ALTER COLUMN "tenant_id" DROP NOT NULL;
