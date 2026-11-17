BEGIN;

-- Reject uncoordinated legacy writes rather than silently serving stale ciphertext.
CREATE FUNCTION guard_integration_credentials() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.credentials_encrypted IS NOT NULL AND
     (NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR
      (TG_TABLE_NAME = 'experiment_settings' AND
       (to_jsonb(NEW)->'ai_api_key' IS DISTINCT FROM to_jsonb(OLD)->'ai_api_key' OR
        to_jsonb(NEW)->'ai_base_url' IS DISTINCT FROM to_jsonb(OLD)->'ai_base_url')) OR
      (TG_TABLE_NAME = 'notification_webhooks' AND
       (to_jsonb(NEW)->'config' IS DISTINCT FROM to_jsonb(OLD)->'config' OR
        to_jsonb(NEW)->'type' IS DISTINCT FROM to_jsonb(OLD)->'type'))) AND
     (NEW.credentials_encrypted IS NULL OR NEW.credentials_encrypted IS NOT DISTINCT FROM OLD.credentials_encrypted) THEN
    RAISE EXCEPTION 'Coordinated integration credential write required';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_experiment_credentials BEFORE UPDATE ON experiment_settings
FOR EACH ROW EXECUTE FUNCTION guard_integration_credentials();
CREATE TRIGGER guard_webhook_credentials BEFORE UPDATE ON notification_webhooks
FOR EACH ROW EXECUTE FUNCTION guard_integration_credentials();

COMMIT;
