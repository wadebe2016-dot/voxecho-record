-- AlterTable
ALTER TABLE "recordings" ADD COLUMN     "operation_category" TEXT NOT NULL DEFAULT 'autre';

-- CreateIndex
CREATE INDEX "recordings_tenant_id_operation_category_idx" ON "recordings"("tenant_id", "operation_category");
