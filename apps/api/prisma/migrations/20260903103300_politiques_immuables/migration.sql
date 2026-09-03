-- Immuabilité des politiques publiées (CLAUDE.md §9.23).
--
-- Une version publiée est opposable : c'est elle qui explique pourquoi tel
-- appel n'a pas été enregistré. La modifier après coup reviendrait à réécrire
-- la raison d'une absence de preuve — exactement ce qu'un contrôleur cherche à
-- exclure. L'api n'expose aucune route qui le permette ; ce déclencheur ajoute
-- le garde-fou en base, comme pour le journal d'audit.
--
-- Un brouillon, lui, se modifie et s'abandonne librement : il n'a aucun effet
-- sur la capture tant qu'il n'est pas publié.

CREATE OR REPLACE FUNCTION recording_policies_publiees_immuables()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION
      'politique publiée immuable : % interdit (locataire=%, version=%)',
      TG_OP, OLD.tenant_id, OLD.version
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS recording_policies_no_update ON "recording_policy_versions";
CREATE TRIGGER recording_policies_no_update
  BEFORE UPDATE ON "recording_policy_versions"
  FOR EACH ROW EXECUTE FUNCTION recording_policies_publiees_immuables();

DROP TRIGGER IF EXISTS recording_policies_no_delete ON "recording_policy_versions";
CREATE TRIGGER recording_policies_no_delete
  BEFORE DELETE ON "recording_policy_versions"
  FOR EACH ROW EXECUTE FUNCTION recording_policies_publiees_immuables();
