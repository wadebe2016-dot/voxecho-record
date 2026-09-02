-- DropForeignKey
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_recording_id_fkey";

-- DropForeignKey
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_user_id_fkey";

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_recording_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
