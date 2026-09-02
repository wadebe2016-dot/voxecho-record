-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'SUPERVISOR', 'AUDITOR');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('outbound', 'inbound', 'internal');

-- CreateEnum
CREATE TYPE "Source" AS ENUM ('cucm-bib', 'siprec', 'simulator');

-- CreateEnum
CREATE TYPE "RecordingStatus" AS ENUM ('stored', 'archived', 'purged', 'hold');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('LOGIN', 'SEARCH', 'LISTEN', 'EXPORT', 'INGEST', 'QUARANTINE', 'PURGE', 'HOLD_SET', 'HOLD_RELEASE');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMP(3),
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recordings" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "refci" TEXT NOT NULL,
    "near" TEXT NOT NULL,
    "far" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "duration_sec" INTEGER NOT NULL,
    "file_path" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "source" "Source" NOT NULL,
    "status" "RecordingStatus" NOT NULL DEFAULT 'stored',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "encrypted" BOOLEAN NOT NULL DEFAULT false,
    "key_ref" TEXT,

    CONSTRAINT "recordings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "action" "AuditAction" NOT NULL,
    "recording_id" UUID,
    "detail" JSONB,
    "ip" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retention_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "days" INTEGER NOT NULL,
    "applies_to" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retention_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_holds" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "recording_id" UUID NOT NULL,
    "set_by" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "released_at" TIMESTAMP(3),

    CONSTRAINT "legal_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_name_key" ON "tenants"("name");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_tenant_id_user_id_idx" ON "refresh_tokens"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "recordings_tenant_id_started_at_idx" ON "recordings"("tenant_id", "started_at");

-- CreateIndex
CREATE INDEX "recordings_tenant_id_near_idx" ON "recordings"("tenant_id", "near");

-- CreateIndex
CREATE INDEX "recordings_tenant_id_far_idx" ON "recordings"("tenant_id", "far");

-- CreateIndex
CREATE INDEX "recordings_tenant_id_status_idx" ON "recordings"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "recordings_tenant_id_sha256_idx" ON "recordings"("tenant_id", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "recordings_tenant_id_file_path_key" ON "recordings"("tenant_id", "file_path");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_at_idx" ON "audit_events"("tenant_id", "at");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_action_idx" ON "audit_events"("tenant_id", "action");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_user_id_idx" ON "audit_events"("tenant_id", "user_id");

-- CreateIndex
CREATE INDEX "audit_events_recording_id_idx" ON "audit_events"("recording_id");

-- CreateIndex
CREATE UNIQUE INDEX "retention_policies_tenant_id_applies_to_key" ON "retention_policies"("tenant_id", "applies_to");

-- CreateIndex
CREATE INDEX "legal_holds_tenant_id_idx" ON "legal_holds"("tenant_id");

-- CreateIndex
CREATE INDEX "legal_holds_recording_id_idx" ON "legal_holds"("recording_id");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recordings" ADD CONSTRAINT "recordings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_recording_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_recording_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_set_by_fkey" FOREIGN KEY ("set_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
