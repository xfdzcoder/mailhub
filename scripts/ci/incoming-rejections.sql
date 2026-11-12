-- Synthetic fixtures only. Run against each disposable, fully migrated database.
INSERT INTO users (id,email,name,password_hash,updated_at) VALUES
 ('56000000-0000-4000-8000-000000000001','rejections@example.invalid','Rejection fixture','unused',now());
INSERT INTO organizations (id,name,slug,updated_at) VALUES
 ('56000000-0000-4000-8000-000000000001','Rejection fixture','rejection-fixture',now());
INSERT INTO organization_members (organization_id,user_id,role) VALUES
 ('56000000-0000-4000-8000-000000000001','56000000-0000-4000-8000-000000000001','admin');
INSERT INTO email_accounts (id,organization_id,owner_user_id,label,email_address,provider,updated_at)
SELECT ('56000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
 '56000000-0000-4000-8000-000000000001','56000000-0000-4000-8000-000000000001',
 'Fixture', 'fixture' || n || '@example.invalid','imap',now()
FROM generate_series(1,2) n;

INSERT INTO incoming_mail_rejections
 (id,account_id,provider,mailbox,uid_validity,uid,reason_code,policy_version)
VALUES ('56000000-0000-4000-8000-000000000001','56000000-0000-4000-8000-000000000001',
 'imap','Actual/Inbox',42,7,'message_size_limit',1);
-- Idempotency must preserve first timestamp and the original expiration.
INSERT INTO incoming_mail_rejections
 (id,account_id,provider,mailbox,uid_validity,uid,reason_code,policy_version)
VALUES ('56000000-0000-4000-8000-000000000099','56000000-0000-4000-8000-000000000001',
 'imap','Actual/Inbox',42,7,'message_size_limit',1)
ON CONFLICT (account_id,mailbox,uid_validity,uid)
DO UPDATE SET last_rejected_at = EXCLUDED.last_rejected_at;

-- Each changed source component and each account is independent.
INSERT INTO incoming_mail_rejections
 (id,account_id,provider,mailbox,uid_validity,uid,reason_code,policy_version)
SELECT ('56000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
 CASE WHEN n = 6 THEN '56000000-0000-4000-8000-000000000002'::uuid
 ELSE '56000000-0000-4000-8000-000000000001'::uuid END,
 'imap', CASE WHEN n = 2 THEN 'Other/Inbox' WHEN n = 3 THEN 'actual/inbox' ELSE 'Actual/Inbox' END,
 CASE WHEN n = 4 THEN 43 ELSE 42 END, CASE WHEN n = 5 THEN 8 ELSE 7 END,
 'mime_depth_limit',1 FROM generate_series(2,6) n;
INSERT INTO incoming_mail_rejections
 (id,account_id,provider,provider_message_id,reason_code,policy_version)
SELECT ('56000000-0000-4000-8000-' || lpad((n+6)::text,12,'0'))::uuid,
 ('56000000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid,
 'gmail','synthetic-provider-id','header_size_limit',1 FROM generate_series(1,2) n;
INSERT INTO incoming_mail_rejections
 (id,account_id,provider,provider_message_id,reason_code,policy_version)
VALUES ('56000000-0000-4000-8000-000000000099','56000000-0000-4000-8000-000000000001',
 'gmail','synthetic-provider-id','header_size_limit',1)
ON CONFLICT (account_id,provider_message_id) DO NOTHING;

DO $$ BEGIN
 IF (SELECT count(*) FROM incoming_mail_rejections) <> 8 THEN
   RAISE EXCEPTION 'Source uniqueness/idempotency failed'; END IF;
 BEGIN
   UPDATE incoming_mail_rejections SET uid_validity = NULL WHERE provider = 'imap';
   RAISE EXCEPTION 'Missing UIDVALIDITY accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
   UPDATE incoming_mail_rejections SET uid = 0 WHERE provider = 'imap';
   RAISE EXCEPTION 'Invalid UID accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
   UPDATE incoming_mail_rejections SET uid_validity = 4294967296 WHERE provider = 'imap';
   RAISE EXCEPTION 'Out-of-range UIDVALIDITY accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
   UPDATE incoming_mail_rejections SET provider_message_id = NULL WHERE provider = 'gmail';
   RAISE EXCEPTION 'Missing Gmail identity accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
   UPDATE incoming_mail_rejections SET policy_version = 0;
   RAISE EXCEPTION 'Invalid policy version accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
   UPDATE incoming_mail_rejections SET mailbox = 'Inbox' WHERE provider = 'gmail';
   RAISE EXCEPTION 'Mixed source accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
   UPDATE incoming_mail_rejections SET reason_code = 'raw diagnostic';
   RAISE EXCEPTION 'Unbounded reason accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
   UPDATE incoming_mail_rejections SET expires_at = first_rejected_at + interval '31 days';
   RAISE EXCEPTION 'Extended retention accepted';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
   UPDATE incoming_mail_rejections SET account_id = '56000000-0000-4000-8000-000000000099'
    WHERE id = '56000000-0000-4000-8000-000000000001';
   RAISE EXCEPTION 'Orphan accepted';
 EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
