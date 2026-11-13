-- Additive only: no mail/account backfill, rewrites, or policy enforcement.
CREATE TABLE "incoming_mail_rejections" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "provider" VARCHAR(10) NOT NULL,
    "mailbox" VARCHAR(1024) COLLATE "C",
    "uid_validity" BIGINT,
    "uid" BIGINT,
    "provider_message_id" VARCHAR(512) COLLATE "C",
    "reason_code" VARCHAR(32) NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "first_rejected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_rejected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '30 days'),
    CONSTRAINT "incoming_mail_rejections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "incoming_rejections_source_check" CHECK (
      ("provider" = 'imap' AND "mailbox" IS NOT NULL AND length("mailbox") > 0
       AND "uid_validity" IS NOT NULL AND "uid_validity" BETWEEN 1 AND 4294967295
       AND "uid" IS NOT NULL AND "uid" BETWEEN 1 AND 4294967295
       AND "provider_message_id" IS NULL)
      OR
      ("provider" = 'gmail' AND "provider_message_id" IS NOT NULL
       AND length("provider_message_id") > 0 AND "mailbox" IS NULL
       AND "uid_validity" IS NULL AND "uid" IS NULL)
    ),
    CONSTRAINT "incoming_rejections_reason_check" CHECK ("reason_code" IN (
      'message_size_limit', 'header_size_limit', 'mime_depth_limit',
      'mime_part_limit', 'attachment_size_limit'
    )),
    CONSTRAINT "incoming_rejections_policy_check" CHECK ("policy_version" > 0),
    CONSTRAINT "incoming_rejections_time_check" CHECK (
      "last_rejected_at" >= "first_rejected_at"
      AND "expires_at" > "first_rejected_at"
      AND "expires_at" <= "first_rejected_at" + interval '30 days'
    ),
    CONSTRAINT "incoming_mail_rejections_account_id_fkey" FOREIGN KEY ("account_id")
      REFERENCES "email_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
-- Shape checks guarantee all fields in the applicable unique key are non-null.
CREATE UNIQUE INDEX "incoming_rejections_imap_key"
  ON "incoming_mail_rejections"("account_id", "mailbox", "uid_validity", "uid");
CREATE UNIQUE INDEX "incoming_rejections_gmail_key"
  ON "incoming_mail_rejections"("account_id", "provider_message_id");
CREATE INDEX "incoming_mail_rejections_expires_at_idx" ON "incoming_mail_rejections"("expires_at");
