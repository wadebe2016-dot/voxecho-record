-- CreateEnum
CREATE TYPE "PurgeRunStatus" AS ENUM ('simulated', 'executed', 'cancelled');

-- CreateEnum
CREATE TYPE "PurgeItemOutcome" AS ENUM ('candidate', 'purged', 'blocked', 'missing');

-- CreateTable
CREATE TABLE "purge_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" "PurgeRunStatus" NOT NULL DEFAULT 'simulated',
    "policy_days" INTEGER NOT NULL,
    "cutoff" TIMESTAMP(3) NOT NULL,
    "candidate_count" INTEGER NOT NULL,
    "candidate_bytes" BIGINT NOT NULL,
    "blocked_count" INTEGER NOT NULL,
    "blocked_bytes" BIGINT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executed_by" UUID,
    "executed_at" TIMESTAMP(3),
    "purged_count" INTEGER,
    "purged_bytes" BIGINT,
    "cancelled_by" UUID,
    "cancelled_at" TIMESTAMP(3),

    CONSTRAINT "purge_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purge_run_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "purge_run_id" UUID NOT NULL,
    "recording_id" UUID NOT NULL,
    "outcome" "PurgeItemOutcome" NOT NULL DEFAULT 'candidate',
    "size_bytes" BIGINT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "blocked" BOOLEAN NOT NULL,
    "blocking_reason" TEXT,

    CONSTRAINT "purge_run_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purge_runs_tenant_id_created_at_idx" ON "purge_runs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "purge_runs_tenant_id_status_idx" ON "purge_runs"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "purge_run_items_tenant_id_idx" ON "purge_run_items"("tenant_id");

-- CreateIndex
CREATE INDEX "purge_run_items_purge_run_id_blocked_idx" ON "purge_run_items"("purge_run_id", "blocked");

-- CreateIndex
CREATE UNIQUE INDEX "purge_run_items_purge_run_id_recording_id_key" ON "purge_run_items"("purge_run_id", "recording_id");

-- AddForeignKey
ALTER TABLE "purge_runs" ADD CONSTRAINT "purge_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purge_runs" ADD CONSTRAINT "purge_runs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purge_runs" ADD CONSTRAINT "purge_runs_executed_by_fkey" FOREIGN KEY ("executed_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purge_runs" ADD CONSTRAINT "purge_runs_cancelled_by_fkey" FOREIGN KEY ("cancelled_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purge_run_items" ADD CONSTRAINT "purge_run_items_purge_run_id_fkey" FOREIGN KEY ("purge_run_id") REFERENCES "purge_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purge_run_items" ADD CONSTRAINT "purge_run_items_recording_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
