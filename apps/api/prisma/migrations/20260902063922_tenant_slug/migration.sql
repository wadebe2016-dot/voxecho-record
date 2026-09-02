-- Ajoute le slug du locataire : nom du sous-répertoire surveillé par
-- l'ingestion, `INGEST_DIR/<slug>/` (contrat §3). La colonne est d'abord
-- nullable pour laisser les locataires existants être renseignés, puis
-- rendue obligatoire et unique.

ALTER TABLE "tenants" ADD COLUMN "slug" TEXT;

-- Reprise : le nom commercial est réduit à un identifiant sûr en chemin.
UPDATE "tenants"
SET "slug" = trim(both '-' from regexp_replace(
  lower(translate("name",
    'àâäáãåçéèêëíìîïñóòôöõúùûüýÿ',
    'aaaaaaceeeeiiiinooooouuuuyy')),
  '[^a-z0-9]+', '-', 'g'))
WHERE "slug" IS NULL;

-- Un nom qui ne laisse aucun caractère utilisable, ou deux noms qui se
-- réduisent au même slug : on désambiguïse par le début de l'identifiant
-- plutôt que d'échouer sur l'index unique.
UPDATE "tenants" t
SET "slug" = coalesce(nullif(t."slug", ''), 'locataire') || '-' || left(t."id"::text, 8)
WHERE t."slug" = ''
   OR EXISTS (SELECT 1 FROM "tenants" o WHERE o."id" <> t."id" AND o."slug" = t."slug");

ALTER TABLE "tenants" ALTER COLUMN "slug" SET NOT NULL;

CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");
