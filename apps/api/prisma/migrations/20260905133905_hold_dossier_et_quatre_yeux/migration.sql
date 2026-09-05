-- Référence de dossier et contre-validation des levées (CLAUDE.md §9.29).
--
-- La colonne est obligatoire pour toute nouvelle conservation, mais la table
-- peut déjà en contenir : un défaut vide accueille les lignes antérieures,
-- puis il est retiré pour que plus rien ne s'écrive sans référence. Une
-- migration qui refuserait de s'appliquer sur une base en service laisserait
-- l'api refuser de démarrer — au pire moment, chez le client.

ALTER TABLE "legal_holds"
  ADD COLUMN "case_reference" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "released_without_second_approval" BOOLEAN NOT NULL DEFAULT false;

-- Les conservations antérieures à cette exigence gardent une référence vide,
-- que le portail affiche « non renseignée » plutôt que d'inventer un dossier.
ALTER TABLE "legal_holds" ALTER COLUMN "case_reference" DROP DEFAULT;
