-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'RETENTION_SET';

-- AlterTable
ALTER TABLE "legal_holds" ADD COLUMN     "release_reason" TEXT,
ADD COLUMN     "released_by" UUID;

-- AlterTable
ALTER TABLE "retention_policies" ADD COLUMN     "below_floor_reason" TEXT,
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "legal_holds_tenant_id_released_at_idx" ON "legal_holds"("tenant_id", "released_at");

-- AddForeignKey
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_released_by_fkey" FOREIGN KEY ("released_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
