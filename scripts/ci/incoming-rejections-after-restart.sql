DO $$ BEGIN
 IF (SELECT count(*) FROM incoming_mail_rejections) <> 8 OR NOT EXISTS (
   SELECT 1 FROM incoming_mail_rejections
   WHERE id = '56000000-0000-4000-8000-000000000001'
     AND first_rejected_at <= last_rejected_at
     AND expires_at = first_rejected_at + interval '30 days'
 ) THEN RAISE EXCEPTION 'Rejection records did not persist intact'; END IF;
END $$;
-- Expiry cleanup must also work without a matching source being fetched again.
UPDATE incoming_mail_rejections
 SET first_rejected_at = now() - interval '31 days',
     last_rejected_at = now() - interval '31 days', expires_at = now() - interval '1 day'
 WHERE id = '56000000-0000-4000-8000-000000000007';
DELETE FROM incoming_mail_rejections WHERE expires_at <= CURRENT_TIMESTAMP;
DO $$ BEGIN
 IF (SELECT count(*) FROM incoming_mail_rejections) <> 7 THEN
   RAISE EXCEPTION 'Retention cleanup failed'; END IF;
END $$;
DELETE FROM email_accounts WHERE id = '56000000-0000-4000-8000-000000000001';
DO $$ BEGIN
 IF (SELECT count(*) FROM incoming_mail_rejections) <> 2 OR EXISTS (
   SELECT 1 FROM incoming_mail_rejections WHERE account_id = '56000000-0000-4000-8000-000000000001'
 ) THEN RAISE EXCEPTION 'Account cascade/scoping failed'; END IF;
END $$;
DELETE FROM email_accounts WHERE id = '56000000-0000-4000-8000-000000000002';
DELETE FROM organization_members WHERE organization_id = '56000000-0000-4000-8000-000000000001';
DELETE FROM organizations WHERE id = '56000000-0000-4000-8000-000000000001';
DELETE FROM users WHERE id = '56000000-0000-4000-8000-000000000001';
