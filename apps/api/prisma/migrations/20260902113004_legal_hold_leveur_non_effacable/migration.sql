-- DropForeignKey
ALTER TABLE "legal_holds" DROP CONSTRAINT "legal_holds_released_by_fkey";

-- AddForeignKey
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_released_by_fkey" FOREIGN KEY ("released_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
