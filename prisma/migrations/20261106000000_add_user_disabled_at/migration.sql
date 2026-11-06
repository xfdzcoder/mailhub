-- Account disabling is global; existing users remain enabled.
ALTER TABLE "users" ADD COLUMN "disabled_at" TIMESTAMPTZ;
