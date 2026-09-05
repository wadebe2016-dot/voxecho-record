-- Comptes d'annuaire — CLAUDE.md §9.37.

-- CreateEnum
CREATE TYPE "SourceCompte" AS ENUM ('local', 'ad');

-- AlterTable : un compte d'annuaire n'a pas de mot de passe local. Rendre la
-- colonne nullable ne touche à aucune ligne existante ; les comptes déjà là
-- gardent leur empreinte et restent `local`.
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;

ALTER TABLE "users" ADD COLUMN "source" "SourceCompte" NOT NULL DEFAULT 'local';
ALTER TABLE "users" ADD COLUMN "external_id" TEXT;
ALTER TABLE "users" ADD COLUMN "directory_seen_at" TIMESTAMP(3);

-- CreateIndex : l'identifiant d'annuaire est unique quand il est présent ;
-- PostgreSQL n'en tient pas compte pour les valeurs nulles.
CREATE UNIQUE INDEX "users_external_id_key" ON "users"("external_id");
