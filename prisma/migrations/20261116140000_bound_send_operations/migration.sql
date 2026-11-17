-- Additive follow-up; released attachment-accounting migrations remain unchanged.
ALTER TABLE "send_operations"
  ADD COLUMN "preparation_expires_at" TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '10 minutes'),
  ADD COLUMN "expires_at" TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '7 days');
-- Existing uncertain markers receive a full replay window from deployment.
CREATE INDEX "send_operations_expires_at_idx" ON "send_operations" ("expires_at");
CREATE INDEX "send_operations_state_preparation_expires_at_idx"
  ON "send_operations" ("state", "preparation_expires_at");
