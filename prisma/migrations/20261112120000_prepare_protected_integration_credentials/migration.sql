-- Storage preparation only: no credential reads, rewrites, defaults or backfill.
-- NOT VALID avoids scanning legacy rows; checks still enforce new/updated rows.
BEGIN;

ALTER TABLE "experiment_settings"
    ADD COLUMN "credentials_encrypted" TEXT,
    ADD COLUMN "credentials_format_version" INTEGER,
    ADD COLUMN "credentials_key_version" VARCHAR(100),
    ADD CONSTRAINT "experiment_settings_credentials_complete" CHECK (
        ("credentials_encrypted" IS NULL AND "credentials_format_version" IS NULL AND "credentials_key_version" IS NULL)
        OR ("credentials_encrypted" IS NOT NULL AND length("credentials_encrypted") > 0
            AND "credentials_format_version" IS NOT NULL AND "credentials_format_version" > 0
            AND "credentials_key_version" IS NOT NULL AND length("credentials_key_version") > 0)
    ) NOT VALID;

ALTER TABLE "notification_webhooks"
    ADD COLUMN "credentials_encrypted" TEXT,
    ADD COLUMN "credentials_format_version" INTEGER,
    ADD COLUMN "credentials_key_version" VARCHAR(100),
    ADD CONSTRAINT "notification_webhooks_credentials_complete" CHECK (
        ("credentials_encrypted" IS NULL AND "credentials_format_version" IS NULL AND "credentials_key_version" IS NULL)
        OR ("credentials_encrypted" IS NOT NULL AND length("credentials_encrypted") > 0
            AND "credentials_format_version" IS NOT NULL AND "credentials_format_version" > 0
            AND "credentials_key_version" IS NOT NULL AND length("credentials_key_version") > 0)
    ) NOT VALID;

COMMIT;
