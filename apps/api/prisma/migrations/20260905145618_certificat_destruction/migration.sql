-- AlterTable
ALTER TABLE "purge_run_items" ADD COLUMN     "operation_category" TEXT,
ADD COLUMN     "policy_days" INTEGER;

-- AlterTable
ALTER TABLE "purge_runs" ADD COLUMN     "certificate_sha256" TEXT;
