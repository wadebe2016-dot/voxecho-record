-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('draft', 'published');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'POLICY_SET';

-- CreateTable
CREATE TABLE "recording_policy_versions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "PolicyStatus" NOT NULL DEFAULT 'draft',
    "document" JSONB NOT NULL,
    "note" TEXT,
    "sha256" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_by" UUID,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "recording_policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recording_policy_versions_tenant_id_status_idx" ON "recording_policy_versions"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "recording_policy_versions_tenant_id_version_key" ON "recording_policy_versions"("tenant_id", "version");

-- AddForeignKey
ALTER TABLE "recording_policy_versions" ADD CONSTRAINT "recording_policy_versions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_policy_versions" ADD CONSTRAINT "recording_policy_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recording_policy_versions" ADD CONSTRAINT "recording_policy_versions_published_by_fkey" FOREIGN KEY ("published_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
