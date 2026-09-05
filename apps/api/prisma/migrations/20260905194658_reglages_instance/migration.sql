-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'SETTINGS_SET';
ALTER TYPE "AuditAction" ADD VALUE 'SETTINGS_TEST';

-- CreateTable
CREATE TABLE "instance_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "updated_by" UUID,

    CONSTRAINT "instance_settings_pkey" PRIMARY KEY ("key")
);

-- AddForeignKey
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
