-- Journal d'audit append-only (CLAUDE.md §5).
-- L'absence de route d'update/delete est vérifiée par les tests ; ce
-- déclencheur ajoute un garde-fou en base : même un accès direct au SQL ne
-- peut ni modifier ni supprimer un événement déjà écrit. C'est la valeur
-- probante du journal qui est en jeu.

CREATE OR REPLACE FUNCTION audit_events_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'audit_events est append-only : % interdit (id=%)',
    TG_OP, COALESCE(OLD.id::text, '?')
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_no_update ON "audit_events";
CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

DROP TRIGGER IF EXISTS audit_events_no_delete ON "audit_events";
CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

-- Le TRUNCATE contourne les déclencheurs FOR EACH ROW : on le bloque aussi.
DROP TRIGGER IF EXISTS audit_events_no_truncate ON "audit_events";
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
