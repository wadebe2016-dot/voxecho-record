-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'USER_SET';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "must_change_password" BOOLEAN NOT NULL DEFAULT false;
