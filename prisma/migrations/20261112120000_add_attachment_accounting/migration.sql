-- Additive only: no legacy rows or files are touched.
CREATE TABLE "stored_attachment_objects" (
 "id" UUID PRIMARY KEY, "storage_key" TEXT NOT NULL UNIQUE,
 "organization_id" UUID, "account_id" UUID,
 "state" TEXT NOT NULL DEFAULT 'UNMEASURED', "measured_bytes" BIGINT,
 "observed_at" TIMESTAMPTZ, "revision" BIGINT NOT NULL DEFAULT 0,
 "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (state IN ('UNMEASURED','PRESENT','MISSING','ERROR','ORPHAN')),
 CHECK (measured_bytes IS NULL OR measured_bytes >= 0),
 CHECK (state <> 'PRESENT' OR (measured_bytes IS NOT NULL AND observed_at IS NOT NULL)),
 CHECK (state <> 'MISSING' OR measured_bytes IS NULL),
 CHECK ((organization_id IS NULL) = (account_id IS NULL)),
 CHECK (revision >= 0)
);
CREATE INDEX "stored_attachment_objects_organization_id_state_idx" ON "stored_attachment_objects"("organization_id", "state");
CREATE INDEX "stored_attachment_objects_account_id_idx" ON "stored_attachment_objects"("account_id");
CREATE TABLE "stored_attachment_references" (
 "attachment_id" UUID PRIMARY KEY,
 "object_id" UUID NOT NULL REFERENCES "stored_attachment_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "stored_attachment_references_object_id_idx" ON "stored_attachment_references"("object_id");
CREATE TABLE "attachment_storage_reservations" (
 "id" UUID PRIMARY KEY, "operation_key" TEXT NOT NULL UNIQUE,
 "organization_id" UUID NOT NULL, "account_id" UUID NOT NULL,
 "object_id" UUID NOT NULL REFERENCES "stored_attachment_objects"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "reserved_bytes" BIGINT NOT NULL CHECK (reserved_bytes >= 0),
 "state" TEXT NOT NULL DEFAULT 'RESERVED' CHECK (state IN ('RESERVED','COMMITTED','RELEASED','EXPIRED')),
 "expires_at" TIMESTAMPTZ NOT NULL,
 "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "attachment_storage_reservations_state_expires_at_idx" ON "attachment_storage_reservations"("state", "expires_at");
CREATE INDEX "attachment_storage_reservations_organization_id_state_idx" ON "attachment_storage_reservations"("organization_id", "state");
