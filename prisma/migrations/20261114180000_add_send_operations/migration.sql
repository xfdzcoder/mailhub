-- Delivery uncertainty survives Redis expiry and process restarts.
CREATE TABLE "send_operations" (
 "id" UUID PRIMARY KEY,
 "organization_id" UUID NOT NULL,
 "user_id" UUID NOT NULL,
 "account_id" UUID NOT NULL,
 "operation_key" TEXT NOT NULL,
 "payload_hash" TEXT NOT NULL,
 "generation" UUID NOT NULL,
 "state" TEXT NOT NULL CHECK (state IN ('PREPARING','RETRYABLE','DELIVERING','DELIVERED')),
 "message_id" TEXT,
 "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE (organization_id, user_id, account_id, operation_key)
);
CREATE INDEX "send_operations_organization_id_state_idx" ON "send_operations" (organization_id, state);
